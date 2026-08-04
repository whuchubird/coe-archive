// /api/beans — 로트 목록·상세·유사 로트. 필터·정렬·페이지네이션을 전부 SQL에서 처리한다.
// 전체 행을 프론트로 보내지 않는 것이 이 프로젝트의 핵심이므로, 조건은 모두 WHERE에서 걸린다.
import express from 'express';
import pool from '../db/pool.js';

const router = express.Router();

// /api/processes는 마운트 경로가 달라 별도 라우터로 내보낸다. server.js에서 따로 붙인다.
export const processesRouter = express.Router();

// 정렬 화이트리스트. 사용자가 보낸 문자열을 SQL에 그대로 넣지 않고 이 표에서 고른다.
// 여기 없는 값이 오면 기본값으로 떨어지므로 ORDER BY 주입이 원천적으로 불가능하다.
const SORT_COLUMNS = {
  score: 'b.score',
  bid: 'b.bid_per_lb',
  value: 'b.total_value_usd',
  rank: 'b.rank'
};
const SORT_DIRECTIONS = { asc: 'ASC', desc: 'DESC' };

const DEFAULT_SORT = 'score';
const DEFAULT_DIRECTION = 'desc';
const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 100;
// 74건짜리 데이터에서 이보다 큰 페이지 번호는 의미가 없다. OFFSET 폭주를 막는 상한.
const MAX_PAGE = 1_000_000;

// 감각 슬라이더 3종. 쿼리 파라미터 이름과 sensory 컬럼을 짝지어 둔다.
const SENSORY_FILTERS = {
  minAcidity: 's.acidity',
  minBody: 's.body',
  minSweetness: 's.sweetness'
};

// 목록·개수·facets가 모두 같은 조건을 봐야 하므로 FROM 절을 한 곳에 둔다.
// sensory는 1:1이라 LEFT JOIN해도 행이 늘지 않는다. 감각 최소값 필터가 여기에 걸린다.
const FROM_BEANS = 'FROM beans b LEFT JOIN sensory s ON s.bean_id = b.id';

// ============================================================
// 쿼리스트링 → SQL 조각
// ============================================================

// "Brazil,Guatemala" 처럼 쉼표로 붙어 오는 값을 배열로 편다. 빈 값은 버린다.
function parseList(value) {
  if (typeof value !== 'string') return [];
  return value.split(',').map((item) => item.trim()).filter((item) => item.length > 0);
}

// 숫자 파라미터. 숫자가 아니면 null을 돌려 조건을 아예 걸지 않는다.
function parseNumber(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// ILIKE에서 %와 _는 와일드카드다. 사용자가 친 글자는 글자 그대로 찾도록 이스케이프한다.
function escapeLike(value) {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

// 쿼리스트링을 WHERE 조건 배열과 파라미터 배열로 바꾼다.
// 값은 하나도 SQL 문자열에 섞지 않고 전부 $1, $2로 넘긴다.
export function buildWhereClause(query) {
  const conditions = [];
  const params = [];

  // 파라미터를 추가하고 그 자리번호($n)를 돌려준다.
  const bind = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  // 체크박스 필터 3종: 배열로 받아 = ANY로 한 번에 비교한다.
  const country = parseList(query.country);
  if (country.length > 0) conditions.push(`b.country = ANY(${bind(country)}::text[])`);

  const award = parseList(query.award);
  if (award.length > 0) conditions.push(`b.award = ANY(${bind(award)}::text[])`);

  const process = parseList(query.process);
  if (process.length > 0) conditions.push(`b.process_key = ANY(${bind(process)}::text[])`);

  // 품종은 M:N이라 bean_varieties를 거쳐야 한다.
  // FROM에 직접 JOIN하면 품종이 여러 개인 로트가 중복 행으로 늘어나 COUNT와 LIMIT이 어긋난다.
  // EXISTS로 감싸면 "조건에 맞는 품종이 하나라도 있는가"만 보므로 행 수가 그대로 유지된다.
  const variety = parseList(query.variety);
  if (variety.length > 0) {
    conditions.push(`EXISTS (
      SELECT 1 FROM bean_varieties bv
      JOIN varieties v ON v.id = bv.variety_id
      WHERE bv.bean_id = b.id AND v.name = ANY(${bind(variety)}::text[])
    )`);
  }

  // 검색어: 농장·생산자·지역은 beans에 있고, 업체명만 M:N이라 EXISTS로 확인한다.
  // 같은 파라미터를 네 곳에서 재사용하므로 자리번호를 한 번만 만든다.
  const keyword = typeof query.q === 'string' ? query.q.trim() : '';
  if (keyword.length > 0) {
    const placeholder = bind(`%${escapeLike(keyword)}%`);
    conditions.push(`(
      b.farm ILIKE ${placeholder}
      OR b.farmer ILIKE ${placeholder}
      OR b.region ILIKE ${placeholder}
      OR EXISTS (
        SELECT 1 FROM bean_buyers bb
        JOIN buyers bu ON bu.id = bb.buyer_id
        WHERE bb.bean_id = b.id AND bu.name ILIKE ${placeholder}
      )
    )`);
  }

  // 최소 점수
  const minScore = parseNumber(query.minScore);
  if (minScore !== null) conditions.push(`b.score >= ${bind(minScore)}`);

  // 감각 6축 중 슬라이더가 붙은 3종의 최소값
  for (const [param, column] of Object.entries(SENSORY_FILTERS)) {
    const value = parseNumber(query[param]);
    if (value !== null) conditions.push(`${column} >= ${bind(value)}`);
  }

  const clause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return { clause, params };
}

// 정렬 컬럼과 방향을 허용 목록에서만 고른다.
// NULLS LAST는 NW 로트(rank가 NULL)가 순위 정렬에서 앞으로 튀어나오지 않게 한다.
// 마지막 b.id는 값이 같은 로트의 순서를 고정해 페이지를 넘길 때 행이 겹치거나 빠지는 것을 막는다.
export function buildOrderClause(sort, order) {
  const column = SORT_COLUMNS[sort] ?? SORT_COLUMNS[DEFAULT_SORT];
  const direction = SORT_DIRECTIONS[order] ?? SORT_DIRECTIONS[DEFAULT_DIRECTION];
  return `ORDER BY ${column} ${direction} NULLS LAST, b.id ASC`;
}

// page·limit을 정수로 바꾸고 범위를 제한한다. limit이 커지면 한 번에 전체를 긁어갈 수 있어 상한을 둔다.
// page에도 상한이 필요하다. page가 지나치게 크면 OFFSET이 PostgreSQL의 bigint 범위를 넘어
// 쿼리 자체가 실패한다 — 사용자 입력 때문에 서버 오류가 나는 셈이라 미리 잘라낸다.
function buildPagination(query) {
  const page = Math.min(MAX_PAGE, Math.max(1, Math.trunc(parseNumber(query.page) ?? 1)));
  const requested = Math.trunc(parseNumber(query.limit) ?? DEFAULT_LIMIT);
  const limit = Math.min(MAX_LIMIT, Math.max(1, requested));
  return { page, limit, offset: (page - 1) * limit };
}

// ============================================================
// 조회
// ============================================================

// 현재 페이지에 보여줄 로트. NUMERIC은 pg가 문자열로 주므로 float8로 캐스팅해 숫자로 내린다.
async function fetchItems(where, params, orderClause, limit, offset) {
  const { rows } = await pool.query(
    `SELECT
       b.id, b.farm, b.farmer, b.country, b.country_ko, b.region, b.year,
       b.award, b.rank, b.category, b.category_ko,
       b.score::float8            AS score,
       b.process_key,
       p.name_ko                  AS process_name_ko,
       b.bid_per_lb::float8       AS bid_per_lb,
       b.weight_lb::float8        AS weight_lb,
       b.total_value_usd::float8  AS total_value_usd,
       b.has_korean_buyer,
       COALESCE((
         SELECT array_agg(v.name ORDER BY v.name)
         FROM bean_varieties bv
         JOIN varieties v ON v.id = bv.variety_id
         WHERE bv.bean_id = b.id
       ), '{}') AS varieties
     ${FROM_BEANS}
     JOIN processes p ON p.key = b.process_key
     ${where}
     ${orderClause}
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );
  return rows;
}

// 같은 WHERE로 전체 건수를 센다. 페이지네이션의 totalPages 계산에 쓴다.
async function fetchTotal(where, params) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total ${FROM_BEANS} ${where}`,
    params
  );
  return rows[0].total;
}

// 현재 필터 조건에서 옵션별 건수를 센다. 체크박스 옆 숫자로 쓴다.
// 세 축의 WHERE와 파라미터가 같으므로 UNION ALL로 묶어 한 번만 왕복한다.
async function fetchFacets(where, params) {
  const { rows } = await pool.query(
    `SELECT 'process' AS dimension, b.process_key AS key, COUNT(*)::int AS count
     ${FROM_BEANS} ${where} GROUP BY b.process_key
     UNION ALL
     SELECT 'country', b.country, COUNT(*)::int
     ${FROM_BEANS} ${where} GROUP BY b.country
     UNION ALL
     SELECT 'award', b.award, COUNT(*)::int
     ${FROM_BEANS} ${where} GROUP BY b.award`,
    params
  );

  // { process: { natural: 25, ... }, country: {...}, award: {...} } 형태로 접어서 내려준다.
  const facets = { process: {}, country: {}, award: {} };
  for (const row of rows) facets[row.dimension][row.key] = row.count;
  return facets;
}

// ============================================================
// 라우터
// ============================================================

// 목록. 필터·정렬·페이지네이션·facets를 모두 SQL로 처리한다.
router.get('/', async (req, res) => {
  const { clause, params } = buildWhereClause(req.query);
  const orderClause = buildOrderClause(req.query.sort, req.query.order);
  const { page, limit, offset } = buildPagination(req.query);

  // 세 쿼리는 서로를 기다릴 이유가 없어 동시에 보낸다.
  const [items, total, facets] = await Promise.all([
    fetchItems(clause, params, orderClause, limit, offset),
    fetchTotal(clause, params),
    fetchFacets(clause, params)
  ]);

  res.json({
    items,
    total,
    page,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    facets
  });
});

// 상세. 품종·업체·향미·감각을 서브쿼리로 묶어 한 번에 내려준다.
// 각각을 따로 조회하면 왕복이 네 번 되고, JOIN으로 펴면 로트 정보가 행 수만큼 중복된다.
router.get('/:id', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT
       b.id, b.farm, b.farmer, b.country, b.country_ko, b.region, b.year,
       b.award, b.rank, b.category, b.category_ko,
       b.score::float8            AS score,
       b.process_key,
       p.name_ko                  AS process_name_ko,
       p.name_en                  AS process_name_en,
       p.summary                  AS process_summary,
       b.bid_per_lb::float8       AS bid_per_lb,
       b.weight_lb::float8        AS weight_lb,
       b.total_value_usd::float8  AS total_value_usd,
       b.has_korean_buyer,
       -- 감각 6축. 공식 데이터가 아닌 추정치이므로 화면에서 그렇게 표기한다.
       CASE WHEN s.bean_id IS NULL THEN NULL ELSE json_build_object(
         'aroma', s.aroma::float8, 'acidity', s.acidity::float8, 'body', s.body::float8,
         'sweetness', s.sweetness::float8, 'aftertaste', s.aftertaste::float8,
         'balance', s.balance::float8
       ) END AS sensory,
       COALESCE((
         SELECT json_agg(v.name ORDER BY v.name)
         FROM bean_varieties bv
         JOIN varieties v ON v.id = bv.variety_id
         WHERE bv.bean_id = b.id
       ), '[]'::json) AS varieties,
       COALESCE((
         SELECT json_agg(json_build_object('name', bu.name, 'is_korean', bu.is_korean) ORDER BY bu.name)
         FROM bean_buyers bb
         JOIN buyers bu ON bu.id = bb.buyer_id
         WHERE bb.bean_id = b.id
       ), '[]'::json) AS buyers,
       COALESCE((
         SELECT json_agg(f.name ORDER BY f.name)
         FROM bean_flavors bf
         JOIN flavor_notes f ON f.id = bf.flavor_id
         WHERE bf.bean_id = b.id
       ), '[]'::json) AS flavor_notes
     FROM beans b
     JOIN processes p ON p.key = b.process_key
     LEFT JOIN sensory s ON s.bean_id = b.id
     WHERE b.id = $1`,
    [req.params.id]
  );

  if (rows.length === 0) {
    return res.status(404).json({ error: '해당 로트를 찾을 수 없습니다.' });
  }
  res.json(rows[0]);
});

// 유사 로트 3건. 감각 6축을 좌표로 보고 유클리드 거리가 가까운 순으로 고른다.
// 거리 계산도 SQL에서 끝내므로 전체 로트를 가져와 JS에서 비교하지 않는다.
// 없는 로트에 빈 배열을 돌려주면 /api/beans/:id가 404를 주는 것과 어긋난다.
// 존재 확인과 유사 로트 조회는 서로를 기다릴 이유가 없어 동시에 보낸다.
router.get('/:id/similar', async (req, res) => {
  const [exists, similar] = await Promise.all([
    pool.query('SELECT 1 FROM beans WHERE id = $1', [req.params.id]),
    pool.query(
      `WITH target AS (
         SELECT * FROM sensory WHERE bean_id = $1
       )
       SELECT
         b.id, b.farm, b.country_ko, b.award, b.rank,
         b.score::float8      AS score,
         b.bid_per_lb::float8 AS bid_per_lb,
         p.name_ko            AS process_name_ko,
         sqrt(
           power(s.aroma      - t.aroma, 2)      + power(s.acidity - t.acidity, 2) +
           power(s.body       - t.body, 2)       + power(s.sweetness - t.sweetness, 2) +
           power(s.aftertaste - t.aftertaste, 2) + power(s.balance - t.balance, 2)
         )::float8 AS distance
       FROM beans b
       JOIN sensory s ON s.bean_id = b.id
       JOIN processes p ON p.key = b.process_key
       CROSS JOIN target t
       WHERE b.id <> $1
       ORDER BY distance ASC, b.id ASC
       LIMIT 3`,
      [req.params.id]
    )
  ]);

  if (exists.rowCount === 0) {
    return res.status(404).json({ error: '해당 로트를 찾을 수 없습니다.' });
  }
  res.json(similar.rows);
});

// 가공방식 5종. 가이드 페이지의 비교표와 아코디언이 이 값을 그대로 쓴다.
processesRouter.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT key, name_ko, name_en, summary, detail, acidity, body, sweetness, cleanliness
     FROM processes
     ORDER BY key`
  );
  res.json(rows);
});

export default router;
