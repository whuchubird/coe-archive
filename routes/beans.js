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

// 로트별 공개 노트 목록. 목록보다 한 화면에 적게 들어가므로 기본값이 더 작다.
const NOTE_DEFAULT_LIMIT = 10;
const NOTE_MAX_LIMIT = 50;

const NOTE_SENSORY_AXES = ['aroma', 'acidity', 'body', 'sweetness', 'aftertaste', 'balance'];

// 감각 슬라이더 3종. 쿼리 파라미터 이름과 sensory 컬럼을 짝지어 둔다.
const SENSORY_FILTERS = {
  minAcidity: 's.acidity',
  minBody: 's.body',
  minSweetness: 's.sweetness'
};

// 목록·개수·facets가 같은 기본 조인을 쓰므로 FROM 절을 한 곳에 둔다.
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
// facet 계산에서는 자기 차원의 조건만 제외할 수 있고, UNION 안에서도 파라미터 번호가
// 겹치지 않도록 시작 번호를 받을 수 있다. 값은 모두 파라미터로 넘긴다.
export function buildWhereClause(query, { exclude = new Set(), parameterOffset = 0 } = {}) {
  const conditions = [];
  const params = [];

  // 파라미터를 추가하고 그 자리번호($n)를 돌려준다.
  const bind = (value) => {
    params.push(value);
    return `$${parameterOffset + params.length}`;
  };

  // 체크박스 필터 3종: 배열로 받아 = ANY로 한 번에 비교한다.
  const country = parseList(query.country);
  if (!exclude.has('country') && country.length > 0) {
    conditions.push(`b.country = ANY(${bind(country)}::text[])`);
  }

  const award = parseList(query.award);
  if (!exclude.has('award') && award.length > 0) {
    conditions.push(`b.award = ANY(${bind(award)}::text[])`);
  }

  const process = parseList(query.process);
  if (!exclude.has('process') && process.length > 0) {
    conditions.push(`b.process_key = ANY(${bind(process)}::text[])`);
  }

  // 품종은 M:N이라 bean_varieties를 거쳐야 한다.
  // FROM에 직접 JOIN하면 품종이 여러 개인 로트가 중복 행으로 늘어나 COUNT와 LIMIT이 어긋난다.
  // EXISTS로 감싸면 "조건에 맞는 품종이 하나라도 있는가"만 보므로 행 수가 그대로 유지된다.
  const variety = parseList(query.variety);
  if (!exclude.has('variety') && variety.length > 0) {
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
function buildPagination(query, { defaultLimit = DEFAULT_LIMIT, maxLimit = MAX_LIMIT } = {}) {
  const page = Math.min(MAX_PAGE, Math.max(1, Math.trunc(parseNumber(query.page) ?? 1)));
  const requested = Math.trunc(parseNumber(query.limit) ?? defaultLimit);
  const limit = Math.min(maxLimit, Math.max(1, requested));
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

// 현재 필터 조건에서 옵션별 건수를 센다. 자기 차원의 조건은 제외해야
// Brazil을 선택한 뒤에도 Guatemala 건수가 남아 두 국가를 함께 선택할 수 있다.
// 각 SELECT의 파라미터 번호를 이어 붙여 UNION ALL 한 번으로 실행한다.
async function fetchFacets(query) {
  const params = [];

  const facetSelect = (dimension, key, joins = '') => {
    const { clause, params: facetParams } = buildWhereClause(query, {
      exclude: new Set([dimension]),
      parameterOffset: params.length
    });
    params.push(...facetParams);
    return `SELECT '${dimension}' AS dimension, ${key} AS key, COUNT(*)::int AS count
            ${FROM_BEANS} ${joins} ${clause} GROUP BY ${key}`;
  };

  const statements = [
    facetSelect('process', 'b.process_key'),
    facetSelect('country', 'b.country'),
    facetSelect('award', 'b.award'),
    // 품종은 M:N이라 연결 테이블을 거친다. 복합 PK 덕분에 같은 로트·품종은 한 번만 센다.
    facetSelect(
      'variety',
      'v.name',
      'JOIN bean_varieties bv ON bv.bean_id = b.id JOIN varieties v ON v.id = bv.variety_id'
    )
  ];

  const { rows } = await pool.query(
    statements.join('\nUNION ALL\n'),
    params
  );

  // { process: { natural: 25, ... }, country: {...}, award: {...}, variety: {...} } 형태로 접어서 내려준다.
  const facets = { process: {}, country: {}, award: {}, variety: {} };
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
    fetchFacets(req.query)
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

// ============================================================
// 로트별 테이스팅 노트 (공개 노트)
// ============================================================

// 한 페이지 분량의 노트를 읽는다.
//
// 비공개 노트의 세부 내용은 SQL 단계에서 잘라낸다. 전부 읽어 온 뒤 응답에서 지우면
// 잠깐이라도 서버 메모리에 남고, 지우는 코드를 한 줄 빠뜨리는 순간 그대로 나간다.
// 애초에 DB에서 꺼내지 않는 편이 확실하다.
//
// viewerId가 null이면(비로그인) `n.user_id = $2`는 참이 아니라 NULL이 되므로
// 비공개 노트의 CASE는 어떤 경우에도 값을 내주지 않는다.
async function fetchBeanNotes(beanId, page, limit, viewerId) {
  const visible = 'n.is_public OR n.user_id = $2';
  const maskedAxes = NOTE_SENSORY_AXES
    .map((axis) => `CASE WHEN ${visible} THEN n.${axis}::float8 END AS ${axis}`)
    .join(',\n       ');

  const { rows } = await pool.query(
    `SELECT
       n.id, n.user_id, n.rating, n.created_at, n.is_public,
       u.username,
       CASE WHEN ${visible} THEN n.brew_method END AS brew_method,
       CASE WHEN ${visible} THEN n.comment END     AS comment,
       ${maskedAxes}
     FROM notes n
     JOIN users u ON u.id = n.user_id
     WHERE n.bean_id = $1
     ORDER BY n.created_at DESC, n.id DESC
     LIMIT $3 OFFSET $4`,
    [beanId, viewerId, limit, (page - 1) * limit]
  );
  return rows;
}

// 로트 전체 노트의 건수와 평균 별점.
//
// 목록 쿼리와 따로 두는 이유는 범위가 다르기 때문이다. 목록은 현재 페이지 10건이지만
// 평균은 그 로트의 모든 노트가 대상이라, 목록에서 계산하면 페이지를 넘길 때마다 값이 달라진다.
// 별점은 공개·비공개 모두 보이는 항목이라 집계에서 빼지 않는다.
async function fetchNoteSummary(beanId) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*)::int                  AS count,
       ROUND(AVG(rating), 1)::float8  AS avg_rating
     FROM notes
     WHERE bean_id = $1`,
    [beanId]
  );
  return { count: rows[0].count, avgRating: rows[0].avg_rating };
}

// 조회 결과 한 줄을 응답 형태로 바꾼다.
//
// 값이 없는 항목은 null을 담지 않고 키 자체를 넣지 않는다.
// 그래야 "비공개라 가려진 것"과 "원래 안 쓴 것"이 응답에서 같은 모양이 되어,
// 비공개 노트에 코멘트가 있었는지조차 밖에서 알 수 없다.
function maskPrivateNote(row, viewerId) {
  const isMine = viewerId !== null && row.user_id === viewerId;

  const note = {
    id: row.id,
    username: row.username,
    rating: row.rating,
    createdAt: row.created_at,
    isPublic: row.is_public,
    isMine
  };

  // 비공개이고 남의 노트면 SQL이 이미 전부 null로 내려보냈다. 여기서 더 볼 것이 없다.
  if (!row.is_public && !isMine) return note;

  if (row.brew_method !== null) note.brewMethod = row.brew_method;
  if (row.comment !== null) note.comment = row.comment;

  // 6축이 모두 비어 있으면 sensory 자체를 넣지 않는다. null만 담긴 객체는 화면에서 쓸 데가 없다.
  const sensory = {};
  for (const axis of NOTE_SENSORY_AXES) {
    if (row[axis] !== null) sensory[axis] = row[axis];
  }
  if (Object.keys(sensory).length > 0) note.sensory = sensory;

  return note;
}

// 로트별 테이스팅 노트 목록.
//
// 로그인하지 않아도 볼 수 있다. 다만 로그인해 있으면 자기 노트를 알아보고,
// 비공개로 둔 자기 글도 읽을 수 있다. 같은 주소가 보는 사람에 따라 다른 응답을 준다.
router.get('/:id/notes', async (req, res) => {
  // 같은 URL이어도 세션 소유자는 자기 비공개 노트의 내용을 받는다.
  // 개인화 응답이 브라우저나 공유 캐시에 남아 다른 사람에게 재사용되지 않게 한다.
  res.set('Cache-Control', 'private, no-store');
  res.vary('Cookie');

  const { page, limit } = buildPagination(req.query, {
    defaultLimit: NOTE_DEFAULT_LIMIT,
    maxLimit: NOTE_MAX_LIMIT
  });
  // 세션이 없으면 비로그인이다. 화면이 보낸 값이 아니라 서버가 들고 있는 세션으로 판정한다.
  const viewerId = req.session?.userId ?? null;

  // 셋은 서로를 기다릴 이유가 없어 동시에 보낸다.
  const [exists, rows, summary] = await Promise.all([
    pool.query('SELECT 1 FROM beans WHERE id = $1', [req.params.id]),
    fetchBeanNotes(req.params.id, page, limit, viewerId),
    fetchNoteSummary(req.params.id)
  ]);

  // 없는 로트에 빈 목록을 주면 /api/beans/:id가 404를 주는 것과 어긋난다.
  if (exists.rowCount === 0) {
    return res.status(404).json({ error: '해당 로트를 찾을 수 없습니다.' });
  }

  res.json({
    items: rows.map((row) => maskPrivateNote(row, viewerId)),
    total: summary.count,
    page,
    totalPages: Math.max(1, Math.ceil(summary.count / limit)),
    summary
  });
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
