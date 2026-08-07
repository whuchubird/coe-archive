// 로트별 테이스팅 노트 더미데이터를 만든다.
//
//   node db/seed-notes.js           → 로트당 15건 생성 (여러 번 실행해도 중복이 쌓이지 않는다)
//   node db/seed-notes.js --clear   → 이 스크립트가 만든 계정과 노트를 전부 지운다
//
// 화면을 채우고 페이지네이션·평균 별점·공개/비공개 표시를 눈으로 확인하려고 만드는 자료다.
// 실제 사용자가 쓴 감상이 아니므로, 지울 때 헷갈리지 않도록 아래 DEMO_USERS 목록에 있는
// 계정만 만들고 그 계정의 노트만 건드린다. 사용자가 직접 만든 계정과 노트는 손대지 않는다.
//
// 전체를 하나의 트랜잭션으로 감싸므로 도중에 실패하면 아무것도 반영되지 않는다.
import bcrypt from 'bcrypt';
import pool, { closePool } from './pool.js';

// 로트 하나당 만들 노트 수.
const NOTES_PER_BEAN = 15;

// 더미 계정. 이 목록이 곧 "지워도 되는 것"의 정의다.
// 실제 사용자가 같은 아이디를 쓸 가능성이 낮도록 서로 겹치지 않는 이름을 골랐다.
const DEMO_USERS = [
  'bora_cupping', 'hanul_brew', 'jiwon_roast', 'minseo_pourover', 'taeyang_lab',
  'sori_filter', 'yeeun_dripper', 'doyun_beans', 'chaewon_kettle', 'seojun_grinder',
  'nara_aroma', 'haeun_acidity', 'jinu_body', 'ssol_sweetness', 'romi_balance',
  'kyul_aftertaste', 'danbi_v60', 'noeul_chemex', 'baram_press', 'gureum_moka'
];

const DEMO_PASSWORD = 'demo1234';

// 노트에 붙일 추출 방식.
const BREW_METHODS = ['V60', '케멕스', '에어로프레스', '프렌치프레스', '클레버', '모카포트', '에스프레소'];

// 코멘트 조각. 앞·가운데·뒤를 섞어 문장을 만든다.
// 같은 문장이 열 번 반복되면 화면이 가짜처럼 보여, 조합으로 변화를 준다.
const COMMENT_OPENERS = [
  '첫 모금에서', '분쇄하자마자', '뜸 들이는 동안', '잔을 코에 대면', '식으면서'
];
const COMMENT_BODIES = [
  '산미가 또렷하게 올라온다', '단맛이 먼저 자리를 잡는다', '바디가 생각보다 묵직하다',
  '향이 오래 남는다', '균형이 잘 잡혀 있다', '과일 향이 앞선다',
  '고소한 쪽으로 기운다', '깔끔하게 떨어진다'
];
const COMMENT_CLOSERS = [
  '온도가 내려갈수록 더 좋아진다.', '다음엔 조금 굵게 갈아 봐야겠다.',
  '비율을 1:16으로 올려도 괜찮을 듯하다.', '아침에 마시기 좋다.',
  '기록해 둘 만한 잔이다.', '다시 사고 싶다.', '기대보다 담백했다.'
];

// 노트 종류. 화면에서 확인해야 할 조합을 빠짐없이 덮는다.
// count의 합이 NOTES_PER_BEAN과 같아야 한다.
const NOTE_KINDS = [
  { key: 'rating-only',        count: 3, comment: false, sensory: false, brew: false, isPublic: true },
  { key: 'rating+sensory',     count: 3, comment: false, sensory: true,  brew: false, isPublic: true },
  { key: 'rating+comment',     count: 3, comment: true,  sensory: false, brew: false, isPublic: true },
  { key: 'full',               count: 2, comment: true,  sensory: true,  brew: true,  isPublic: true },
  { key: 'private:rating',     count: 2, comment: false, sensory: false, brew: false, isPublic: false },
  { key: 'private:comment',    count: 1, comment: true,  sensory: false, brew: false, isPublic: false },
  { key: 'private:full',       count: 1, comment: true,  sensory: true,  brew: true,  isPublic: false }
];

// ============================================================
// 난수 — 같은 씨앗이면 같은 결과가 나온다
// ============================================================

// 실행할 때마다 데이터가 달라지면 화면을 비교하기 어렵다.
// Math.random() 대신 씨앗을 고정한 생성기를 써서 몇 번을 돌려도 같은 자료가 나오게 한다.
function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 문자열을 숫자 씨앗으로 바꾼다. 로트마다 다른 값이 나오되 매번 같도록.
function seedFrom(text) {
  let hash = 2166136261;
  for (const ch of text) {
    hash ^= ch.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

const pick = (random, list) => list[Math.floor(random() * list.length)];

// ============================================================
// 값 만들기
// ============================================================

// 별점. 로트 점수가 높을수록 후한 별점이 나오도록 기울인다.
// 전부 무작위면 통계 화면에서 로트별 차이가 보이지 않는다.
function makeRating(random, score) {
  // 86~92점을 대략 3~5점대로 옮긴다.
  const base = 3 + ((Number(score) - 86) / 6) * 1.6;
  const jitter = (random() - 0.5) * 1.8;
  return Math.max(1, Math.min(5, Math.round(base + jitter)));
}

// 감각 6축. 로트에 기록된 추정치를 중심으로 흔든다.
// 사람마다 조금씩 다르게 느끼는 편이 자연스럽고, 추천 기능의 거리 계산도 의미를 갖는다.
function makeSensory(random, beanSensory) {
  const axes = ['aroma', 'acidity', 'body', 'sweetness', 'aftertaste', 'balance'];
  const result = {};
  for (const axis of axes) {
    const center = Number(beanSensory?.[axis] ?? 3.5);
    const value = center + (random() - 0.5) * 1.6;
    // 노트의 감각 축은 0~5를 허용하지만, 사람이 매기는 값이라 1 아래로는 내리지 않는다.
    result[axis] = Math.round(Math.max(1, Math.min(5, value)) * 10) / 10;
  }
  return result;
}

// 코멘트 한 줄. 로트의 향미 키워드가 있으면 앞에 붙여 로트마다 다르게 읽히게 한다.
function makeComment(random, flavors) {
  const parts = [`${pick(random, COMMENT_OPENERS)} ${pick(random, COMMENT_BODIES)}.`];
  if (flavors.length > 0 && random() < 0.6) {
    parts.push(`${pick(random, flavors)} 쪽 인상이 강하다.`);
  }
  parts.push(pick(random, COMMENT_CLOSERS));
  return parts.join(' ');
}

// 작성 시각. 최근 120일 안에 흩어 놓아 최신순 정렬과 페이지 넘김이 의미를 갖게 한다.
function makeCreatedAt(random) {
  const daysAgo = random() * 120;
  const at = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  return at.toISOString();
}

// ============================================================
// DB 작업
// ============================================================

// 더미 계정을 확보한다. 이미 있으면 그대로 쓰고 없으면 만든다.
// 해시는 한 번만 계산해 돌려쓴다 — 스무 번 해싱하면 몇 초가 그냥 날아간다.
async function ensureDemoUsers(client) {
  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);

  await client.query(
    `INSERT INTO users (username, password_hash)
     SELECT candidate, $2
       FROM unnest($1::text[]) AS candidate
      WHERE NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.username) = lower(candidate))`,
    [DEMO_USERS, hash]
  );

  const { rows } = await client.query(
    'SELECT id, username FROM users WHERE username = ANY($1::text[]) ORDER BY id',
    [DEMO_USERS]
  );
  return rows;
}

// 이 스크립트가 만든 노트만 지운다. 사용자가 쓴 노트는 건드리지 않는다.
async function clearDemoNotes(client, userIds) {
  if (userIds.length === 0) return 0;
  const { rowCount } = await client.query(
    'DELETE FROM notes WHERE user_id = ANY($1::int[])',
    [userIds]
  );
  return rowCount;
}

// 로트와 감각·향미를 함께 읽는다. 노트 내용을 로트에 맞춰 만들기 위해서다.
async function loadBeans(client) {
  const { rows } = await client.query(
    `SELECT
       b.id, b.score::float8 AS score,
       s.aroma::float8      AS aroma,
       s.acidity::float8    AS acidity,
       s.body::float8       AS body,
       s.sweetness::float8  AS sweetness,
       s.aftertaste::float8 AS aftertaste,
       s.balance::float8    AS balance,
       COALESCE((
         SELECT array_agg(f.name ORDER BY f.name)
         FROM bean_flavors bf JOIN flavor_notes f ON f.id = bf.flavor_id
         WHERE bf.bean_id = b.id
       ), '{}') AS flavors
     FROM beans b
     LEFT JOIN sensory s ON s.bean_id = b.id
     ORDER BY b.id`
  );
  return rows;
}

// 로트 하나에 붙일 노트 15건을 만든다. DB에는 아직 넣지 않는다.
function buildNotesFor(bean, users) {
  const random = makeRandom(seedFrom(bean.id));
  const notes = [];

  // 같은 사람이 같은 로트에 여러 번 쓰지 않도록 작성자를 섞어 앞에서부터 꺼내 쓴다.
  const shuffled = [...users];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  let authorIndex = 0;
  for (const kind of NOTE_KINDS) {
    for (let i = 0; i < kind.count; i += 1) {
      const author = shuffled[authorIndex % shuffled.length];
      authorIndex += 1;

      const sensory = kind.sensory ? makeSensory(random, bean) : null;
      notes.push({
        userId: author.id,
        beanId: bean.id,
        brewMethod: kind.brew ? pick(random, BREW_METHODS) : null,
        rating: makeRating(random, bean.score),
        comment: kind.comment ? makeComment(random, bean.flavors) : null,
        aroma: sensory?.aroma ?? null,
        acidity: sensory?.acidity ?? null,
        body: sensory?.body ?? null,
        sweetness: sensory?.sweetness ?? null,
        aftertaste: sensory?.aftertaste ?? null,
        balance: sensory?.balance ?? null,
        isPublic: kind.isPublic,
        createdAt: makeCreatedAt(random),
        kind: kind.key
      });
    }
  }
  return notes;
}

// 여러 행을 한 번에 넣는다. 파라미터 수에 상한이 있어 덩어리로 나눈다.
const COLUMNS_PER_ROW = 13;
const CHUNK_SIZE = 400;

async function insertNotes(client, notes) {
  for (let start = 0; start < notes.length; start += CHUNK_SIZE) {
    const chunk = notes.slice(start, start + CHUNK_SIZE);
    const params = [];
    const placeholders = chunk.map((note, index) => {
      const base = index * COLUMNS_PER_ROW;
      params.push(
        note.userId, note.beanId, note.brewMethod, note.rating, note.comment,
        note.aroma, note.acidity, note.body, note.sweetness, note.aftertaste, note.balance,
        note.isPublic, note.createdAt
      );
      const slots = Array.from({ length: COLUMNS_PER_ROW }, (_, k) => `$${base + k + 1}`);
      return `(${slots.join(',')})`;
    });

    // created_at을 직접 넣으므로 updated_at도 같은 값으로 맞춘다.
    //
    // VALUES 목록만으로는 PostgreSQL이 열의 형을 알 수 없어 전부 text로 잡는다.
    // 넣을 컬럼의 형에 맞춰 여기서 명시적으로 바꿔 준다.
    await client.query(
      `INSERT INTO notes (
         user_id, bean_id, brew_method, rating, comment,
         aroma, acidity, body, sweetness, aftertaste, balance,
         is_public, created_at, updated_at
       )
       SELECT
         v.user_id::int, v.bean_id::text, v.brew_method::text,
         v.rating::smallint, v.comment::text,
         v.aroma::numeric(2,1), v.acidity::numeric(2,1), v.body::numeric(2,1),
         v.sweetness::numeric(2,1), v.aftertaste::numeric(2,1), v.balance::numeric(2,1),
         v.is_public::boolean, v.created_at::timestamptz, v.created_at::timestamptz
       FROM (VALUES ${placeholders.join(',')}) AS v (
         user_id, bean_id, brew_method, rating, comment,
         aroma, acidity, body, sweetness, aftertaste, balance,
         is_public, created_at
       )`,
      params
    );
  }
}

// 만들어진 결과를 종류별로 세어 보여준다.
function printSummary(notes) {
  const byKind = new Map();
  for (const note of notes) byKind.set(note.kind, (byKind.get(note.kind) ?? 0) + 1);

  console.log('\n  종류별 건수');
  for (const kind of NOTE_KINDS) {
    const label = {
      'rating-only': '별점만',
      'rating+sensory': '별점 + 감각 6축',
      'rating+comment': '별점 + 코멘트',
      full: '별점 + 코멘트 + 감각 + 추출',
      'private:rating': '별점만 (비공개)',
      'private:comment': '별점 + 코멘트 (비공개)',
      'private:full': '전체 기록 (비공개)'
    }[kind.key];
    console.log(`    ${label.padEnd(26)} ${String(byKind.get(kind.key) ?? 0).padStart(5)}건`);
  }
}

// ============================================================
// 실행
// ============================================================

// --clear: 더미 계정과 그 노트를 지운다. 계정을 지우면 노트는 CASCADE로 함께 사라진다.
async function clearAll() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT id, username FROM users WHERE username = ANY($1::text[])',
      [DEMO_USERS]
    );
    if (rows.length === 0) {
      console.log('[seed-notes] 지울 더미 계정이 없다.');
      await client.query('COMMIT');
      return;
    }
    const removed = await clearDemoNotes(client, rows.map((r) => r.id));
    await client.query('DELETE FROM users WHERE id = ANY($1::int[])', [rows.map((r) => r.id)]);
    await client.query('COMMIT');
    console.log(`[seed-notes] 더미 계정 ${rows.length}개, 노트 ${removed}건을 지웠다.`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const users = await ensureDemoUsers(client);
    console.log(`[seed-notes] 더미 계정 ${users.length}명 준비`);

    // 다시 실행해도 쌓이지 않도록 이 계정들의 기존 노트를 먼저 비운다.
    const removed = await clearDemoNotes(client, users.map((u) => u.id));
    if (removed > 0) console.log(`[seed-notes] 이전 더미 노트 ${removed}건 정리`);

    const beans = await loadBeans(client);
    const notes = beans.flatMap((bean) => buildNotesFor(bean, users));

    await insertNotes(client, notes);

    // 사용자가 직접 쓴 노트가 그대로인지 같은 트랜잭션에서 확인한다.
    const { rows: mine } = await client.query(
      'SELECT COUNT(*)::int AS count FROM notes WHERE NOT (user_id = ANY($1::int[]))',
      [users.map((u) => u.id)]
    );

    await client.query('COMMIT');

    console.log(`[seed-notes] 완료 — 로트 ${beans.length}건 × ${NOTES_PER_BEAN}건 = 노트 ${notes.length}건`);
    printSummary(notes);
    console.log(`\n  더미가 아닌 노트 ${mine[0].count}건은 그대로 두었다.`);
    console.log(`  더미 계정 비밀번호는 '${DEMO_PASSWORD}' 다. 지우려면 --clear 를 쓴다.`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

try {
  if (process.argv.includes('--clear')) await clearAll();
  else await main();
} catch (err) {
  console.error('[seed-notes] 실패 — 아무것도 반영되지 않았다.');
  console.error(err);
  process.exitCode = 1;
} finally {
  await closePool();
}
