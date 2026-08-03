// data/beans.json을 읽어 DB에 적재한다.
//   node db/seed.js            → 시딩만 (여러 번 실행해도 안전)
//   node db/seed.js --reset    → schema.sql로 테이블을 다시 만든 뒤 시딩
// 전체를 하나의 트랜잭션으로 감싸므로 도중에 실패하면 아무것도 반영되지 않는다.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pool, { closePool } from './pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
const DATA_PATH = path.join(__dirname, '..', 'data', 'beans.json');

// 업체·품종·향미 이름을 비교할 때 쓰는 키. 앞뒤 공백과 대소문자 차이를 없앤다.
const nameKey = (name) => name.trim().toLowerCase();

// 업체 국적은 로트 단위 hasKoreanBuyer 값으로 추론할 수 없다.
// 공동 낙찰 로트는 어느 업체가 한국 업체인지 구분되지 않으므로 공식 결과와
// 업체 정보를 확인한 목록을 명시적으로 관리한다. 대소문자 차이는 nameKey로 흡수한다.
const VERIFIED_KOREAN_BUYERS = new Set([
  'MI Coffee Corporation',
  'Dongsuh Foods Corporation',
  'DAESANG DIVES',
  'MOMOS COFFEE',
  'GESHARY COFFEE',
  'Terarosa (Haksan Co. Ltd)',
  'Ryans Coffee Roasters',
  'COFFEE COUNTY',
  'Saerin (MOGIPOGROUND)'
].map(nameKey));

// ============================================================
// 데이터 정리 — DB에 넣기 전에 JS에서 중복을 걷어낸다.
// ============================================================

// 여러 로트에 흩어진 이름을 유일 목록으로 모은다. 표기는 처음 등장한 것을 쓴다.
// 원본에 'Ryans Coffee Roasters'와 'RYANS COFFEE ROASTERS'가 섞여 있어,
// 그대로 넣으면 같은 회사가 마스터 테이블에서 두 행으로 갈라진다.
function collectUniqueNames(beans, pick) {
  const canonical = new Map(); // 비교용 키 → 실제로 저장할 표기
  for (const bean of beans) {
    for (const raw of pick(bean)) {
      const key = nameKey(raw);
      if (!canonical.has(key)) canonical.set(key, raw.trim());
    }
  }
  return canonical;
}

// 검증된 업체 목록과 로트 단위 hasKoreanBuyer 값이 서로 맞는지 확인한다.
// 불일치를 허용하면 통계 기준에 따라 한국 낙찰 건수가 달라지므로 시딩을 중단한다.
function resolveKoreanBuyers(beans) {
  const mismatches = beans.filter((bean) => {
    const hasVerifiedKoreanBuyer = bean.auction.buyers
      .some((name) => VERIFIED_KOREAN_BUYERS.has(nameKey(name)));
    return hasVerifiedKoreanBuyer !== bean.auction.hasKoreanBuyer;
  });

  if (mismatches.length > 0) {
    const ids = mismatches.map((bean) => bean.id).join(', ');
    throw new Error(`한국 업체 검증 목록과 hasKoreanBuyer가 일치하지 않는 로트: ${ids}`);
  }

  return VERIFIED_KOREAN_BUYERS;
}

// ============================================================
// 적재 — 부모 테이블부터 순서대로
// ============================================================

// 가공방식 5종. beans가 process_key로 참조하므로 가장 먼저 넣는다.
async function seedProcesses(client, processes) {
  for (const p of processes) {
    await client.query(
      `INSERT INTO processes (key, name_ko, name_en, summary, detail, acidity, body, sweetness, cleanliness)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (key) DO UPDATE SET
         name_ko = EXCLUDED.name_ko, name_en = EXCLUDED.name_en,
         summary = EXCLUDED.summary, detail  = EXCLUDED.detail,
         acidity = EXCLUDED.acidity, body    = EXCLUDED.body,
         sweetness = EXCLUDED.sweetness, cleanliness = EXCLUDED.cleanliness`,
      [p.key, p.nameKo, p.nameEn, p.summary, p.detail, p.acidity, p.body, p.sweetness, p.cleanliness]
    );
  }
}

// 로트 본체. 이미 있는 id면 값을 갱신해 두 번 실행해도 행이 늘지 않는다.
async function seedBeans(client, beans) {
  for (const b of beans) {
    await client.query(
      `INSERT INTO beans (
         id, farm, farmer, country, country_ko, region, year, award, rank,
         category, category_ko, score, process_key,
         bid_per_lb, weight_lb, total_value_usd, has_korean_buyer
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (id) DO UPDATE SET
         farm = EXCLUDED.farm, farmer = EXCLUDED.farmer,
         country = EXCLUDED.country, country_ko = EXCLUDED.country_ko,
         region = EXCLUDED.region, year = EXCLUDED.year,
         award = EXCLUDED.award, rank = EXCLUDED.rank,
         category = EXCLUDED.category, category_ko = EXCLUDED.category_ko,
         score = EXCLUDED.score, process_key = EXCLUDED.process_key,
         bid_per_lb = EXCLUDED.bid_per_lb, weight_lb = EXCLUDED.weight_lb,
         total_value_usd = EXCLUDED.total_value_usd,
         has_korean_buyer = EXCLUDED.has_korean_buyer`,
      [
        b.id, b.farm, b.farmer, b.country, b.countryKo, b.region, b.year, b.award, b.rank,
        b.category, b.categoryKo, b.score, b.process,
        b.auction.bidPerLb, b.auction.weightLb, b.auction.totalValueUsd, b.auction.hasKoreanBuyer
      ]
    );
  }
}

// 감각 6축 (1:1). 공식 데이터가 아닌 추정치라는 점은 화면에서 표기한다.
async function seedSensory(client, beans) {
  for (const b of beans) {
    const s = b.sensory;
    await client.query(
      `INSERT INTO sensory (bean_id, aroma, acidity, body, sweetness, aftertaste, balance)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (bean_id) DO UPDATE SET
         aroma = EXCLUDED.aroma, acidity = EXCLUDED.acidity, body = EXCLUDED.body,
         sweetness = EXCLUDED.sweetness, aftertaste = EXCLUDED.aftertaste,
         balance = EXCLUDED.balance`,
      [b.id, s.aroma, s.acidity, s.body, s.sweetness, s.aftertaste, s.balance]
    );
  }
}

// 이름 목록을 마스터 테이블에 한 번에 넣는다.
// unnest로 배열 하나를 여러 행으로 펼치므로, 값이 몇 개든 쿼리는 한 번이다.
async function insertNames(client, table, names) {
  if (names.length === 0) return;
  await client.query(
    `INSERT INTO ${table} (name) SELECT unnest($1::text[]) ON CONFLICT (name) DO NOTHING`,
    [names]
  );
}

// 방금 넣은 마스터 테이블에서 이름 → id 대응표를 가져온다. 연결 테이블을 채우려면 id가 필요하다.
async function loadNameToId(client, table) {
  const { rows } = await client.query(`SELECT id, name FROM ${table}`);
  return new Map(rows.map((row) => [nameKey(row.name), row.id]));
}

// 연결 테이블 적재. (로트 id, 마스터 id) 쌍 배열을 한 번에 밀어 넣는다.
// 복합 기본키가 있으므로 ON CONFLICT DO NOTHING이면 재실행해도 중복이 쌓이지 않는다.
async function insertLinks(client, table, idColumn, pairs) {
  if (pairs.length === 0) return;
  await client.query(
    `INSERT INTO ${table} (bean_id, ${idColumn})
     SELECT * FROM unnest($1::text[], $2::int[])
     ON CONFLICT DO NOTHING`,
    [pairs.map((pair) => pair[0]), pairs.map((pair) => pair[1])]
  );
}

// 로트마다 흩어진 이름을 (로트 id, 마스터 id) 쌍으로 바꾼다.
function buildPairs(beans, pick, nameToId) {
  const pairs = [];
  for (const bean of beans) {
    for (const raw of pick(bean)) {
      pairs.push([bean.id, nameToId.get(nameKey(raw))]);
    }
  }
  return pairs;
}

// 품종·업체·향미: 마스터를 먼저 채우고 id를 받아 연결 테이블을 채운다.
async function seedManyToMany(client, beans, koreanBuyerKeys) {
  const varieties = collectUniqueNames(beans, (b) => b.varieties);
  const buyers = collectUniqueNames(beans, (b) => b.auction.buyers);
  const flavors = collectUniqueNames(beans, (b) => b.flavorNotes);

  await insertNames(client, 'varieties', [...varieties.values()]);
  await insertNames(client, 'flavor_notes', [...flavors.values()]);

  // 업체만 is_korean 컬럼이 있어 따로 넣는다.
  const buyerKeys = [...buyers.keys()];
  await client.query(
    `INSERT INTO buyers (name, is_korean)
     SELECT * FROM unnest($1::text[], $2::boolean[])
     ON CONFLICT (name) DO UPDATE SET is_korean = EXCLUDED.is_korean`,
    [buyerKeys.map((key) => buyers.get(key)), buyerKeys.map((key) => koreanBuyerKeys.has(key))]
  );

  const varietyIds = await loadNameToId(client, 'varieties');
  const buyerIds = await loadNameToId(client, 'buyers');
  const flavorIds = await loadNameToId(client, 'flavor_notes');

  await insertLinks(client, 'bean_varieties', 'variety_id', buildPairs(beans, (b) => b.varieties, varietyIds));
  await insertLinks(client, 'bean_buyers', 'buyer_id', buildPairs(beans, (b) => b.auction.buyers, buyerIds));
  await insertLinks(client, 'bean_flavors', 'flavor_id', buildPairs(beans, (b) => b.flavorNotes, flavorIds));
}

// ============================================================
// 결과 확인
// ============================================================

// 테이블별 행 수를 한 번의 쿼리로 센다.
async function countRows(client) {
  const { rows } = await client.query(`
    SELECT 'processes'      AS table_name, COUNT(*)::int AS n FROM processes
    UNION ALL SELECT 'beans',          COUNT(*)::int FROM beans
    UNION ALL SELECT 'sensory',        COUNT(*)::int FROM sensory
    UNION ALL SELECT 'varieties',      COUNT(*)::int FROM varieties
    UNION ALL SELECT 'bean_varieties', COUNT(*)::int FROM bean_varieties
    UNION ALL SELECT 'buyers',         COUNT(*)::int FROM buyers
    UNION ALL SELECT 'bean_buyers',    COUNT(*)::int FROM bean_buyers
    UNION ALL SELECT 'flavor_notes',   COUNT(*)::int FROM flavor_notes
    UNION ALL SELECT 'bean_flavors',   COUNT(*)::int FROM bean_flavors
    UNION ALL SELECT 'users',          COUNT(*)::int FROM users
    UNION ALL SELECT 'notes',          COUNT(*)::int FROM notes
    UNION ALL SELECT 'favorites',      COUNT(*)::int FROM favorites
  `);
  return rows;
}

function printCounts(rows) {
  console.log('\n테이블별 건수');
  console.log('─'.repeat(30));
  for (const row of rows) {
    console.log(`  ${row.table_name.padEnd(16)}${String(row.n).padStart(6)}`);
  }
  console.log('─'.repeat(30));
}

// ============================================================
// 진입점
// ============================================================

async function main() {
  const shouldReset = process.argv.includes('--reset');

  const { processes, beans } = JSON.parse(await readFile(DATA_PATH, 'utf8'));
  const korean = resolveKoreanBuyers(beans);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // PostgreSQL은 DDL도 트랜잭션에 포함된다. 시딩이 실패하면 테이블 재생성까지 함께 되돌아간다.
    if (shouldReset) {
      console.log('[seed] schema.sql 적용 — 기존 테이블을 지우고 다시 만든다');
      await client.query(await readFile(SCHEMA_PATH, 'utf8'));
    }

    await seedProcesses(client, processes);
    await seedBeans(client, beans);
    await seedSensory(client, beans);
    await seedManyToMany(client, beans, korean);

    const counts = await countRows(client);
    await client.query('COMMIT');

    console.log(`[seed] 완료 — 로트 ${beans.length}건, 한국 업체로 확정된 곳 ${korean.size}곳`);
    printCounts(counts);

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

try {
  await main();
} catch (err) {
  console.error('[seed] 실패 — 아무것도 반영되지 않았다.');
  console.error(err);
  process.exitCode = 1;
} finally {
  await closePool();
}
