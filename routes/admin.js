// /api/admin — 로트·사용자 관리. 전 구간 requireAdmin.
//
// 노트 CRUD와 다른 점이 셋이다.
//   1) 인가 — 로그인만으로는 부족하고 role이 admin이어야 한다
//   2) 트랜잭션 — 로트 하나를 고치면 6개 테이블이 함께 바뀐다. 하나라도 실패하면 전부 되돌린다
//   3) 참조 무결성 — 노트가 달린 로트는 지울 수 없다
//
// 검증은 전부 서버에서 한다. 화면의 검사는 편의일 뿐이라 믿지 않는다.
import express from 'express';
import pool from '../db/pool.js';
import { requireAdmin } from '../middleware/require-admin.js';

const router = express.Router();

// 이 라우터의 모든 경로에 인가 검사를 건다.
router.use(requireAdmin);

const SENSORY_AXES = ['aroma', 'acidity', 'body', 'sweetness', 'aftertaste', 'balance'];

// 명세의 검증 범위.
const SCORE_MIN = 0;
const SCORE_MAX = 100;
const AXIS_MIN = 1;
const AXIS_MAX = 5;
const ID_PATTERN = /^[A-Za-z0-9]+$/;
const BID_PER_LB_MAX = 999_999.99;       // NUMERIC(8,2)
const WEIGHT_LB_MAX = 9_999_999.99;      // NUMERIC(9,2)
const TOTAL_VALUE_MAX = 9_999_999_999.99; // NUMERIC(12,2)
const MASTER_NAME_MAX = 200;
const MASTER_LIST_MAX = 100;

const ROLES = new Set(['user', 'admin']);

// users.id는 INTEGER라 이 값을 넘으면 DB가 범위 초과로 실패한다.
// Number('99999999999999999999')는 Number.isInteger를 통과하므로 상한을 따로 본다.
const MAX_USER_ID = 2_147_483_647;

// 관리용 목록의 정렬 화이트리스트. 사용자가 보낸 문자열을 SQL에 그대로 넣지 않는다.
const SORT_COLUMNS = {
  id: 'b.id',
  farm: 'b.farm',
  score: 'b.score',
  bid: 'b.bid_per_lb',
  notes: 'note_count'
};
const SORT_DIRECTIONS = { asc: 'ASC', desc: 'DESC' };

// ============================================================
// 입력 검증
// ============================================================

// 숫자 필드. 불리언·배열·객체가 숫자로 둔갑하지 않도록 타입부터 확인한다.
// (Number(true)는 1이라 타입 검사 없이 받으면 true가 1점으로 저장된다)
function parseNumber(value, { min, max, required = false, integer = false, label }) {
  if (value === undefined || value === null || value === '') {
    if (required) return { error: `${label} 값을 입력해 주세요.` };
    return { value: null };
  }
  if (typeof value !== 'number' && typeof value !== 'string') {
    return { error: `${label} 값은 숫자여야 합니다.` };
  }
  // Number('   ')는 0이므로 문자열 공백은 숫자로 바꾸기 전에 빈 값으로 처리한다.
  if (typeof value === 'string' && value.trim() === '') {
    if (required) return { error: `${label} 값을 입력해 주세요.` };
    return { value: null };
  }
  const parsed = Number(typeof value === 'string' ? value.trim() : value);
  if (!Number.isFinite(parsed)) return { error: `${label} 값은 숫자여야 합니다.` };
  if (integer && !Number.isInteger(parsed)) return { error: `${label} 값은 정수여야 합니다.` };
  if (min !== undefined && parsed < min) return { error: `${label} 값은 ${min} 이상이어야 합니다.` };
  if (max !== undefined && parsed > max) return { error: `${label} 값은 ${max} 이하여야 합니다.` };
  return { value: parsed };
}

// 문자열 필드. 값이 없으면 null로 둔다.
function parseText(value, { required = false, max = 200, label }) {
  if (value === undefined || value === null) {
    if (required) return { error: `${label} 값을 입력해 주세요.` };
    return { value: null };
  }
  if (typeof value !== 'string') return { error: `${label} 형식이 올바르지 않습니다.` };
  const trimmed = value.trim();
  if (trimmed === '') {
    if (required) return { error: `${label} 값을 입력해 주세요.` };
    return { value: null };
  }
  if ([...trimmed].length > max) return { error: `${label}은(는) ${max}자 이하로 입력해 주세요.` };
  return { value: trimmed };
}

// 품종·향미·낙찰업체는 배열로 받되, 쉼표로 이어 붙인 문자열도 받아들인다.
// 화면이 태그 입력을 쓰든 한 줄 입력을 쓰든 서버가 같은 형태로 정리한다.
function parseNameList(value, label) {
  if (value === undefined || value === null || value === '') return { value: [] };

  let items;
  if (Array.isArray(value)) items = value;
  else if (typeof value === 'string') items = value.split(',');
  else return { error: `${label} 형식이 올바르지 않습니다.` };

  if (items.some((item) => typeof item !== 'string')) {
    return { error: `${label} 목록은 문자열이어야 합니다.` };
  }
  if (items.length > MASTER_LIST_MAX) {
    return { error: `${label} 목록은 ${MASTER_LIST_MAX}개 이하로 입력해 주세요.` };
  }

  // 앞뒤 공백을 떼고 빈 값을 버린 뒤, 대소문자만 다른 중복을 합친다.
  const seen = new Map();
  for (const raw of items) {
    const name = raw.trim();
    if (name === '') continue;
    if ([...name].length > MASTER_NAME_MAX) {
      return { error: `${label}의 각 이름은 ${MASTER_NAME_MAX}자 이하로 입력해 주세요.` };
    }
    const key = name.toLowerCase();
    if (!seen.has(key)) seen.set(key, name);
  }
  return { value: [...seen.values()] };
}

// 생성 본문과 수정·삭제 경로가 같은 로트 ID 규칙을 쓰게 한다.
function parseBeanId(value) {
  const parsed = parseText(value, { required: true, max: 32, label: '로트 ID' });
  if (parsed.error) return parsed;
  if (!ID_PATTERN.test(parsed.value)) {
    return { error: '로트 ID는 영문자와 숫자만 쓸 수 있습니다.' };
  }
  return { value: parsed.value.toUpperCase() };
}

// 로트 한 건의 입력을 통째로 검증해 DB에 넣을 형태로 돌려준다.
// 실패하면 { error } 하나만 돌려 화면이 그대로 보여줄 수 있게 한다.
function validateBean(body, { requireId }) {
  const input = body ?? {};

  // 로트 ID — 수정할 때는 경로에서 받으므로 본문에서 요구하지 않는다.
  let id = null;
  if (requireId) {
    const parsed = parseBeanId(input.id);
    if (parsed.error) return { error: parsed.error };
    id = parsed.value;
  }

  const farm = parseText(input.farm, { required: true, max: 120, label: '농장명' });
  if (farm.error) return { error: farm.error };

  const farmer = parseText(input.farmer, { max: 120, label: '생산자' });
  if (farmer.error) return { error: farmer.error };

  const country = parseText(input.country, { required: true, max: 60, label: '국가(영문)' });
  if (country.error) return { error: country.error };

  const countryKo = parseText(input.country_ko, { required: true, max: 60, label: '국가(한글)' });
  if (countryKo.error) return { error: countryKo.error };

  const region = parseText(input.region, { max: 120, label: '지역' });
  if (region.error) return { error: region.error };

  const category = parseText(input.category, { max: 120, label: '부문(영문)' });
  if (category.error) return { error: category.error };

  const categoryKo = parseText(input.category_ko, { max: 120, label: '부문(한글)' });
  if (categoryKo.error) return { error: categoryKo.error };

  const processKey = parseText(input.process_key, { required: true, max: 40, label: '가공방식' });
  if (processKey.error) return { error: processKey.error };

  // 등급은 명세의 두 값만 받는다.
  const award = parseText(input.award, { required: true, max: 10, label: '등급' });
  if (award.error) return { error: award.error };
  if (award.value !== 'COE' && award.value !== 'NW') {
    return { error: '등급은 COE 또는 NW여야 합니다.' };
  }

  const year = parseNumber(input.year, { min: 2000, max: 2100, required: true, integer: true, label: '연도' });
  if (year.error) return { error: year.error };

  // NW 로트는 순위가 없어 비워 둘 수 있다.
  const rank = parseNumber(input.rank, { min: 1, max: 999, integer: true, label: '순위' });
  if (rank.error) return { error: rank.error };

  const score = parseNumber(input.score, { min: SCORE_MIN, max: SCORE_MAX, required: true, label: '점수' });
  if (score.error) return { error: score.error };

  const bidPerLb = parseNumber(input.bid_per_lb, { min: 0, max: BID_PER_LB_MAX, label: '낙찰가' });
  if (bidPerLb.error) return { error: bidPerLb.error };

  const weightLb = parseNumber(input.weight_lb, { min: 0, max: WEIGHT_LB_MAX, label: '중량' });
  if (weightLb.error) return { error: weightLb.error };

  const totalValue = parseNumber(input.total_value_usd, { min: 0, max: TOTAL_VALUE_MAX, label: '총 낙찰액' });
  if (totalValue.error) return { error: totalValue.error };

  // 감각 6축은 1~5. 응답의 sensory 객체를 그대로 다시 보낼 수도 있고,
  // 폼에서 축을 최상위 필드로 보낼 수도 있게 두 형태를 같은 규칙으로 검증한다.
  if (
    input.sensory !== undefined && input.sensory !== null
    && (typeof input.sensory !== 'object' || Array.isArray(input.sensory))
  ) {
    return { error: '감각 정보 형식이 올바르지 않습니다.' };
  }
  const sensoryInput = input.sensory ?? input;
  const sensory = {};
  for (const axis of SENSORY_AXES) {
    const parsed = parseNumber(sensoryInput[axis], { min: AXIS_MIN, max: AXIS_MAX, label: `감각(${axis})` });
    if (parsed.error) return { error: parsed.error };
    sensory[axis] = parsed.value;
  }

  const varieties = parseNameList(input.varieties, '품종');
  if (varieties.error) return { error: varieties.error };

  const flavors = parseNameList(input.flavor_notes, '향미');
  if (flavors.error) return { error: flavors.error };

  const buyers = parseNameList(input.buyers, '낙찰 업체');
  if (buyers.error) return { error: buyers.error };

  return {
    value: {
      id,
      farm: farm.value,
      farmer: farmer.value,
      country: country.value,
      countryKo: countryKo.value,
      region: region.value,
      year: year.value,
      award: award.value,
      rank: rank.value,
      category: category.value,
      categoryKo: categoryKo.value,
      score: score.value,
      processKey: processKey.value,
      bidPerLb: bidPerLb.value,
      weightLb: weightLb.value,
      totalValue: totalValue.value,
      sensory,
      varieties: varieties.value,
      flavors: flavors.value,
      buyers: buyers.value
    }
  };
}

// ============================================================
// 트랜잭션 안에서 쓰는 조각들
// ============================================================

// 트랜잭션 도중 발견한 문제를 예외로 올린다.
// 이렇게 해야 ROLLBACK을 타면서도 500이 아니라 알맞은 상태 코드로 답할 수 있다.
class ValidationError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.name = 'ValidationError';
    this.status = status;
    this.extra = extra;
  }
}

// 가공방식은 processes에 있는 key만 받는다. 없는 key면 외래키 위반 전에 걸러 문구를 준다.
async function assertProcessExists(client, processKey) {
  const { rowCount } = await client.query('SELECT 1 FROM processes WHERE key = $1', [processKey]);
  if (rowCount === 0) throw new ValidationError('존재하지 않는 가공방식입니다.');
}

// 테이블·컬럼 이름은 SQL에서 파라미터로 묶을 수 없어 문자열로 넣어야 한다.
// 사용자 입력이 닿지 않는 자리지만, 실수로도 들어갈 수 없게 허용 목록으로 못 박는다.
const MASTER_TABLES = new Set(['varieties', 'flavor_notes', 'buyers']);
const LINK_TABLES = {
  bean_varieties: 'variety_id',
  bean_flavors: 'flavor_id',
  bean_buyers: 'buyer_id'
};

// 마스터 테이블에서 이름 → id를 얻는다. 이미 있으면 그대로 쓰고 없으면 새로 만든다.
// 대소문자만 다른 이름이 두 행으로 갈라지지 않도록 lower()로 맞춰 찾는다.
async function resolveMasterIds(client, table, names) {
  if (!MASTER_TABLES.has(table)) throw new Error(`허용되지 않은 테이블: ${table}`);
  if (names.length === 0) return [];

  // UNIQUE(name)는 대소문자를 구분한다. 동시에 'Geisha'와 'geisha'가 들어오면
  // 양쪽 NOT EXISTS가 모두 참이 될 수 있으므로, 소문자 이름별 트랜잭션 잠금으로 직렬화한다.
  // 정렬된 순서로 잠가 여러 이름을 동시에 처리할 때 교착도 피한다.
  for (const normalizedName of names.map((name) => name.toLowerCase()).sort()) {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      [table, normalizedName]
    );
  }

  // 없는 것만 새로 넣는다. 이미 있으면 아무 일도 하지 않는다.
  await client.query(
    `INSERT INTO ${table} (name)
     SELECT candidate
       FROM unnest($1::text[]) AS candidate
      WHERE NOT EXISTS (
        SELECT 1 FROM ${table} m WHERE lower(m.name) = lower(candidate)
      )`,
    [names]
  );

  // UNIQUE는 대소문자를 가리므로 'Geisha'와 'geisha'가 이미 따로 들어가 있을 수 있다.
  // 그런 경우 이름 하나가 id 둘로 잡히지 않도록 하나만 고른다.
  const { rows } = await client.query(
    `SELECT DISTINCT ON (lower(name)) id, name
       FROM ${table}
      WHERE lower(name) = ANY($1::text[])
      ORDER BY lower(name), id`,
    [names.map((name) => name.toLowerCase())]
  );
  return rows.map((row) => row.id);
}

// 연결 테이블을 통째로 다시 쓴다. 기존 행을 지우고 새 목록을 넣는다.
// 무엇이 늘고 줄었는지 비교하는 것보다 단순하고, 트랜잭션 안이라 중간 상태가 보이지 않는다.
async function replaceLinks(client, table, beanId, ids) {
  const idColumn = LINK_TABLES[table];
  if (!idColumn) throw new Error(`허용되지 않은 테이블: ${table}`);

  await client.query(`DELETE FROM ${table} WHERE bean_id = $1`, [beanId]);
  if (ids.length === 0) return;
  await client.query(
    `INSERT INTO ${table} (bean_id, ${idColumn})
     SELECT $1, unnest($2::int[])
     ON CONFLICT DO NOTHING`,
    [beanId, ids]
  );
}

// 로트에 붙은 낙찰 업체 중 한국 업체가 있으면 has_korean_buyer를 켠다.
// 관리자가 직접 켜고 끄게 두면 업체 목록과 어긋날 수 있어, 업체를 근거로 계산한다.
async function syncKoreanBuyerFlag(client, beanId) {
  await client.query(
    `UPDATE beans b
        SET has_korean_buyer = EXISTS (
          SELECT 1 FROM bean_buyers bb
          JOIN buyers bu ON bu.id = bb.buyer_id
          WHERE bb.bean_id = b.id AND bu.is_korean
        )
      WHERE b.id = $1`,
    [beanId]
  );
}

// 명세의 순서대로 로트 한 건을 쓴다.
//   beans → sensory → varieties/bean_varieties → flavor_notes/bean_flavors → buyers/bean_buyers
// 호출부가 BEGIN/COMMIT을 잡고, 여기서는 예외만 올린다.
async function writeBean(client, bean, { isCreate }) {
  await assertProcessExists(client, bean.processKey);

  if (isCreate) {
    await client.query(
      `INSERT INTO beans (
         id, farm, farmer, country, country_ko, region, year, award, rank,
         category, category_ko, score, process_key,
         bid_per_lb, weight_lb, total_value_usd
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        bean.id, bean.farm, bean.farmer, bean.country, bean.countryKo, bean.region,
        bean.year, bean.award, bean.rank, bean.category, bean.categoryKo,
        bean.score, bean.processKey, bean.bidPerLb, bean.weightLb, bean.totalValue
      ]
    );
  } else {
    const { rowCount } = await client.query(
      `UPDATE beans SET
         farm = $2, farmer = $3, country = $4, country_ko = $5, region = $6,
         year = $7, award = $8, rank = $9, category = $10, category_ko = $11,
         score = $12, process_key = $13,
         bid_per_lb = $14, weight_lb = $15, total_value_usd = $16
       WHERE id = $1`,
      [
        bean.id, bean.farm, bean.farmer, bean.country, bean.countryKo, bean.region,
        bean.year, bean.award, bean.rank, bean.category, bean.categoryKo,
        bean.score, bean.processKey, bean.bidPerLb, bean.weightLb, bean.totalValue
      ]
    );
    if (rowCount === 0) throw new ValidationError('로트를 찾을 수 없습니다.', 404);
  }

  // 감각 6축 (1:1)
  // 6축이 전부 비었으면 행을 남기지 않는다. 값이 전부 NULL인 행은 "기록 없음"과
  // 같은 뜻인데, 레이더 차트나 유사 로트 계산에서는 있는 것처럼 잡혀 방해가 된다.
  const hasAnyAxis = SENSORY_AXES.some((axis) => bean.sensory[axis] !== null);
  if (hasAnyAxis) {
    await client.query(
      `INSERT INTO sensory (bean_id, aroma, acidity, body, sweetness, aftertaste, balance)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (bean_id) DO UPDATE SET
         aroma = EXCLUDED.aroma, acidity = EXCLUDED.acidity, body = EXCLUDED.body,
         sweetness = EXCLUDED.sweetness, aftertaste = EXCLUDED.aftertaste,
         balance = EXCLUDED.balance`,
      [bean.id, ...SENSORY_AXES.map((axis) => bean.sensory[axis])]
    );
  } else {
    await client.query('DELETE FROM sensory WHERE bean_id = $1', [bean.id]);
  }

  // 품종 · 향미 · 낙찰 업체 — 마스터를 채우고 연결을 다시 쓴다
  const varietyIds = await resolveMasterIds(client, 'varieties', bean.varieties);
  await replaceLinks(client, 'bean_varieties', bean.id, varietyIds);

  const flavorIds = await resolveMasterIds(client, 'flavor_notes', bean.flavors);
  await replaceLinks(client, 'bean_flavors', bean.id, flavorIds);

  const buyerIds = await resolveMasterIds(client, 'buyers', bean.buyers);
  await replaceLinks(client, 'bean_buyers', bean.id, buyerIds);

  await syncKoreanBuyerFlag(client, bean.id);
}

// 트랜잭션을 열고 작업을 실행한다. 실패하면 되돌린다.
async function inTransaction(run) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// 저장한 로트를 화면이 바로 쓸 수 있는 형태로 다시 읽는다.
async function readBean(executor, beanId) {
  const { rows } = await executor.query(
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
       CASE WHEN s.bean_id IS NULL THEN NULL ELSE json_build_object(
         'aroma', s.aroma::float8, 'acidity', s.acidity::float8, 'body', s.body::float8,
         'sweetness', s.sweetness::float8, 'aftertaste', s.aftertaste::float8,
         'balance', s.balance::float8
       ) END AS sensory,
       COALESCE((SELECT json_agg(v.name ORDER BY v.name)
                 FROM bean_varieties bv JOIN varieties v ON v.id = bv.variety_id
                 WHERE bv.bean_id = b.id), '[]'::json) AS varieties,
       COALESCE((SELECT json_agg(f.name ORDER BY f.name)
                 FROM bean_flavors bf JOIN flavor_notes f ON f.id = bf.flavor_id
                 WHERE bf.bean_id = b.id), '[]'::json) AS flavor_notes,
       COALESCE((SELECT json_agg(bu.name ORDER BY bu.name)
                 FROM bean_buyers bb JOIN buyers bu ON bu.id = bb.buyer_id
                 WHERE bb.bean_id = b.id), '[]'::json) AS buyers
     FROM beans b
     JOIN processes p ON p.key = b.process_key
     LEFT JOIN sensory s ON s.bean_id = b.id
     WHERE b.id = $1`,
    [beanId]
  );
  return rows[0] ?? null;
}

// ============================================================
// 로트
// ============================================================

// 관리용 목록. 노트 수를 함께 세어 삭제 가능 여부를 화면이 미리 알 수 있게 한다.
router.get('/beans', async (req, res) => {
  const keyword = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const sort = SORT_COLUMNS[req.query.sort] ?? SORT_COLUMNS.id;
  const direction = SORT_DIRECTIONS[req.query.order] ?? 'ASC';

  const params = [];
  let where = '';
  if (keyword !== '') {
    // %와 _는 와일드카드라 글자 그대로 찾도록 이스케이프한다.
    params.push(`%${keyword.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
    where = 'WHERE b.id ILIKE $1 OR b.farm ILIKE $1 OR b.country_ko ILIKE $1';
  }

  const { rows } = await pool.query(
    `SELECT
       b.id, b.farm, b.country_ko,
       b.score::float8      AS score,
       b.bid_per_lb::float8 AS bid_per_lb,
       b.award, b.rank,
       p.name_ko            AS process_name_ko,
       b.process_key,
       (SELECT COUNT(*) FROM notes n WHERE n.bean_id = b.id)::int     AS note_count,
       (SELECT COUNT(*) FROM favorites f WHERE f.bean_id = b.id)::int AS favorite_count
     FROM beans b
     JOIN processes p ON p.key = b.process_key
     ${where}
     ORDER BY ${sort} ${direction} NULLS LAST, b.id ASC`,
    params
  );
  res.json(rows);
});

// 로트 추가. 명세의 순서대로 6개 테이블을 한 트랜잭션에서 채운다.
router.post('/beans', async (req, res) => {
  const { error, value } = validateBean(req.body, { requireId: true });
  if (error) return res.status(400).json({ error });

  try {
    const bean = await inTransaction(async (client) => {
      // 중복 ID는 기본키가 막지만, 먼저 확인해 사람이 읽을 문구를 준다.
      const { rowCount } = await client.query('SELECT 1 FROM beans WHERE id = $1', [value.id]);
      if (rowCount > 0) throw new ValidationError('이미 존재하는 로트 ID입니다.', 409);

      await writeBean(client, value, { isCreate: true });
      return readBean(client, value.id);
    });
    res.status(201).json(bean);
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(err.status).json({ error: err.message, ...err.extra });
    }
    // 경합으로 기본키가 겹친 경우
    if (err.code === '23505') return res.status(409).json({ error: '이미 존재하는 로트 ID입니다.' });
    throw err;
  }
});

// 로트 수정. 연결 테이블은 기존 행을 지우고 다시 넣는다.
router.put('/beans/:id', async (req, res) => {
  const { error, value } = validateBean(req.body, { requireId: false });
  if (error) return res.status(400).json({ error });

  // 대상은 경로에서 정한다. 본문의 id로 다른 로트를 건드릴 수 없다.
  const beanId = parseBeanId(req.params.id);
  if (beanId.error) return res.status(400).json({ error: beanId.error });
  value.id = beanId.value;

  try {
    const bean = await inTransaction(async (client) => {
      await writeBean(client, value, { isCreate: false });
      return readBean(client, value.id);
    });
    res.json(bean);
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(err.status).json({ error: err.message, ...err.extra });
    }
    throw err;
  }
});

// 로트 삭제. 노트가 달려 있으면 거부하고, 아니면 연결 테이블까지 함께 지운다.
router.delete('/beans/:id', async (req, res) => {
  const parsedBeanId = parseBeanId(req.params.id);
  if (parsedBeanId.error) return res.status(400).json({ error: parsedBeanId.error });
  const beanId = parsedBeanId.value;

  try {
    const result = await inTransaction(async (client) => {
      // 로트 행을 먼저 잠가 노트 수 확인과 삭제 사이에 새 참조가 끼어들지 못하게 한다.
      const { rowCount } = await client.query(
        'SELECT 1 FROM beans WHERE id = $1 FOR UPDATE',
        [beanId]
      );
      if (rowCount === 0) throw new ValidationError('로트를 찾을 수 없습니다.', 404);

      // 노트는 사용자가 쓴 기록이라 로트를 지운다고 함께 지울 수 없다.
      // 남의 기록을 말없이 없애는 셈이기 때문이다.
      const { rows: noteRows } = await client.query(
        'SELECT COUNT(*)::int AS count FROM notes WHERE bean_id = $1',
        [beanId]
      );
      if (noteRows[0].count > 0) {
        throw new ValidationError(
          '이 로트에 작성된 노트가 있어 삭제할 수 없습니다.',
          409,
          { noteCount: noteRows[0].count }
        );
      }

      // 즐겨찾기는 언제든 다시 담을 수 있는 표시라 함께 정리한다.
      const { rowCount: removedFavorites } = await client.query(
        'DELETE FROM favorites WHERE bean_id = $1',
        [beanId]
      );

      // 연결 테이블과 감각은 스키마상 CASCADE지만, 무엇이 지워지는지 코드에 드러나도록 직접 지운다.
      await client.query('DELETE FROM bean_varieties WHERE bean_id = $1', [beanId]);
      await client.query('DELETE FROM bean_buyers WHERE bean_id = $1', [beanId]);
      await client.query('DELETE FROM bean_flavors WHERE bean_id = $1', [beanId]);
      await client.query('DELETE FROM sensory WHERE bean_id = $1', [beanId]);
      await client.query('DELETE FROM beans WHERE id = $1', [beanId]);

      return { deleted: beanId, removedFavorites };
    });
    res.json(result);
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(err.status).json({ error: err.message, ...err.extra });
    }
    throw err;
  }
});

// ============================================================
// 사용자
// ============================================================

// 사용자 목록. 노트 수와 가입일을 함께 센다.
router.get('/users', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT
       u.id, u.username, u.role, u.created_at,
       (SELECT COUNT(*) FROM notes n WHERE n.user_id = u.id)::int     AS note_count,
       (SELECT COUNT(*) FROM favorites f WHERE f.user_id = u.id)::int AS favorite_count
     FROM users u
     ORDER BY u.created_at DESC, u.id DESC`
  );
  res.json(rows);
});

// 권한 변경. 자기 자신은 바꿀 수 없다.
// 스스로 강등하지 못하게 막으면 관리자가 0명이 되는 사고도 함께 막힌다.
router.patch('/users/:id/role', async (req, res) => {
  const targetId = Number(req.params.id);
  if (!Number.isInteger(targetId) || targetId < 1 || targetId > MAX_USER_ID) {
    return res.status(400).json({ error: '잘못된 사용자 번호입니다.' });
  }

  const role = req.body?.role;
  if (typeof role !== 'string' || !ROLES.has(role)) {
    return res.status(400).json({ error: "권한은 'user' 또는 'admin'이어야 합니다." });
  }

  if (targetId === req.session.userId) {
    return res.status(403).json({ error: '자신의 권한은 변경할 수 없습니다.' });
  }

  const { rows } = await pool.query(
    `UPDATE users SET role = $2 WHERE id = $1
     RETURNING id, username, role, created_at`,
    [targetId, role]
  );

  if (rows.length === 0) {
    return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
  }
  res.json(rows[0]);
});

// 계정 삭제. 권한 변경과 같은 이유로 자기 자신은 지울 수 없다.
//
// 로트 삭제와 정책이 다르다. 로트에 달린 노트는 남이 쓴 기록이라 지우기를 거부하지만,
// 여기서 사라지는 노트는 삭제 대상 본인의 것이므로 계정과 함께 정리하는 것이 맞다.
// 대신 몇 건이 사라지는지 응답에 담아, 관리자가 모르고 지우는 일이 없게 한다.
router.delete('/users/:id', async (req, res) => {
  const targetId = Number(req.params.id);
  if (!Number.isInteger(targetId) || targetId < 1 || targetId > MAX_USER_ID) {
    return res.status(400).json({ error: '잘못된 사용자 번호입니다.' });
  }

  // 스스로를 지우지 못하게 막으면 관리자가 0명이 되는 사고도 함께 막힌다.
  if (targetId === req.session.userId) {
    return res.status(403).json({ error: '자신의 계정은 삭제할 수 없습니다.' });
  }

  try {
    const result = await inTransaction(async (client) => {
      const { rows } = await client.query(
        // 같은 계정에 대한 권한 변경·삭제가 겹쳐도 삭제 대상과 응답이 어긋나지 않게 잠근다.
        'SELECT id, username, role FROM users WHERE id = $1 FOR UPDATE',
        [targetId]
      );
      if (rows.length === 0) throw new ValidationError('사용자를 찾을 수 없습니다.', 404);

      // 무엇이 함께 사라지는지 미리 센다. 삭제 후에는 셀 수 없다.
      const { rows: counts } = await client.query(
        `SELECT (SELECT COUNT(*)::int FROM notes     WHERE user_id = $1) AS notes,
                (SELECT COUNT(*)::int FROM favorites WHERE user_id = $1) AS favorites`,
        [targetId]
      );

      // notes·favorites의 user_id는 ON DELETE CASCADE라 함께 지워지지만,
      // 무엇이 사라지는지 코드에 드러나도록 직접 지운다.
      await client.query('DELETE FROM favorites WHERE user_id = $1', [targetId]);
      await client.query('DELETE FROM notes WHERE user_id = $1', [targetId]);
      await client.query('DELETE FROM users WHERE id = $1', [targetId]);

      return {
        deleted: rows[0].id,
        username: rows[0].username,
        removedNotes: counts[0].notes,
        removedFavorites: counts[0].favorites
      };
    });
    res.json(result);
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(err.status).json({ error: err.message, ...err.extra });
    }
    throw err;
  }
});

// ============================================================
// 대시보드
// ============================================================

// 총계와 최근 활동. 집계는 전부 SQL에서 끝낸다.
router.get('/summary', async (req, res) => {
  const [totals, recentUsers, recentNotes] = await Promise.all([
    pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM beans)     AS beans,
         (SELECT COUNT(*)::int FROM users)     AS users,
         (SELECT COUNT(*)::int FROM notes)     AS notes,
         (SELECT COUNT(*)::int FROM favorites) AS favorites,
         (SELECT COUNT(*)::int FROM users WHERE role = 'admin') AS admins`
    ),
    pool.query(
      `SELECT id, username, role, created_at
       FROM users ORDER BY created_at DESC, id DESC LIMIT 5`
    ),
    pool.query(
      `SELECT n.id, n.bean_id, n.rating, n.created_at,
              u.username, b.farm
       FROM notes n
       JOIN users u ON u.id = n.user_id
       JOIN beans b ON b.id = n.bean_id
       ORDER BY n.created_at DESC, n.id DESC LIMIT 5`
    )
  ]);

  res.json({
    totals: totals.rows[0],
    recentUsers: recentUsers.rows,
    recentNotes: recentNotes.rows
  });
});

export default router;
