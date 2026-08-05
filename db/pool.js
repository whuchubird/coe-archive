// DB 연결을 한 곳에서 만들어 앱 전체가 공유한다.
//
// 드라이버가 둘이다.
//   pg   — 5432 포트로 직접 붙는 기본 드라이버. 로컬 PostgreSQL과 배포 환경에서 쓴다.
//   neon — Neon이 제공하는 443(WebSocket) 드라이버. 학교·회사망처럼 5432가 막힌
//          곳에서도 붙는다. SQL과 호출 방식은 pg와 같아 쿼리는 한 줄도 바뀌지 않는다.
//
// 기본은 pg이고, pg가 네트워크 문제로 못 붙을 때만 자동으로 neon으로 넘어간다.
// 어느 쪽을 쓸지 강제하려면 .env에 DB_DRIVER=pg 또는 DB_DRIVER=neon을 넣는다.
import 'dotenv/config';
import pg from 'pg';
import { Pool as NeonPool } from '@neondatabase/serverless';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL이 없다. .env.example을 .env로 복사해 값을 채운다.');
}

// 로컬 PostgreSQL은 평문 연결이지만 Neon은 TLS만 허용한다. 호스트를 보고 판단한다.
const isLocalHost = /@(localhost|127\.0\.0\.1)/.test(connectionString);

// rejectUnauthorized: true — 서버 인증서를 실제로 검증한다.
// Neon 인증서는 공인 CA가 발급하므로 그대로 통과한다.
const ssl = isLocalHost ? false : { rejectUnauthorized: true };

const POOL_MAX = 10;
const IDLE_TIMEOUT_MS = 30_000;
// 자동 전환을 판단하는 시간. 너무 길면 기동이 느려지고 짧으면 멀쩡한 연결을 포기한다.
const CONNECT_TIMEOUT_MS = 8_000;

// 포트가 막혔거나 호스트에 닿지 못한 경우. 자격 증명 오류와 구분해야 한다.
// 비밀번호가 틀린 것뿐인데 드라이버를 바꾸면 원인을 더 찾기 어려워진다.
const NETWORK_ERROR_CODES = new Set([
  'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'EHOSTUNREACH'
]);

// 이 오류가 "못 닿아서"인지 판단한다. 드라이버를 바꿔 볼 가치가 있는지 여기서 갈린다.
function isNetworkError(err) {
  if (NETWORK_ERROR_CODES.has(err.code)) return true;
  if (NETWORK_ERROR_CODES.has(err.cause?.code)) return true;
  // pg는 연결 타임아웃을 코드 없이 메시지로만 알려주는 경우가 있다.
  return /connection timeout|Connection terminated/i.test(err.message ?? '');
}

// ============================================================
// 드라이버별 풀 생성
// ============================================================

function createPgPool() {
  const pool = new pg.Pool({
    connectionString,
    ssl,
    max: POOL_MAX,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS
  });
  // 유휴 연결이 끊겨도 프로세스가 죽지 않도록 잡아둔다.
  pool.on('error', (err) => console.error('[db] 유휴 연결 오류:', err.message));
  return pool;
}

// 443(WebSocket)으로 붙는 풀. 5432가 막힌 망에서 쓰며 호출 방식은 pg와 같다.
function createNeonPool() {
  const pool = new NeonPool({
    connectionString,
    max: POOL_MAX,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS
  });
  pool.on('error', (err) => console.error('[db] 유휴 연결 오류:', err.message));
  return pool;
}

// 실제로 쿼리가 나가는지 확인한다. 풀을 만드는 것만으로는 연결 여부를 알 수 없다.
async function probe(pool) {
  await pool.query('SELECT 1');
  return pool;
}

// 풀을 하나 골라 돌려준다. 실패하면 이유를 그대로 던져 호출부가 판단한다.
async function selectPool() {
  const forced = process.env.DB_DRIVER;

  if (forced === 'neon') {
    console.log('[db] DB_DRIVER=neon — 443 드라이버로 연결한다');
    return probe(createNeonPool());
  }
  if (forced === 'pg') {
    console.log('[db] DB_DRIVER=pg — 5432 드라이버로 연결한다');
    return probe(createPgPool());
  }

  // 자동: pg를 먼저 시도한다.
  const pgPool = createPgPool();
  try {
    return await probe(pgPool);
  } catch (err) {
    // 자격 증명·권한 문제라면 드라이버를 바꿔도 똑같이 실패한다. 그대로 알린다.
    if (!isNetworkError(err) || isLocalHost) throw err;

    await pgPool.end().catch(() => {});
    console.warn(`[db] 5432 연결 실패(${err.code ?? err.message}) — 443 드라이버로 다시 시도한다`);

    const neonPool = createNeonPool();
    try {
      const ready = await probe(neonPool);
      console.log('[db] 443 드라이버로 연결됨. 5432가 막힌 네트워크로 보인다');
      return ready;
    } catch (fallbackError) {
      await neonPool.end().catch(() => {});
      // 둘 다 실패하면 처음 원인을 보여주는 편이 문제 파악에 낫다.
      throw err;
    }
  }
}

// ============================================================
// 지연 초기화
// ============================================================

// 라우터는 pool.query(...)를 그대로 부른다. 어느 드라이버가 선택됐는지는 알 필요가 없다.
let activePool = null;
let pending = null;

// 쓸 준비가 된 풀을 돌려준다. 첫 호출에서만 드라이버를 고르고 이후에는 그대로 재사용한다.
async function getPool() {
  if (activePool) return activePool;
  // 동시에 여러 요청이 들어와도 연결 시도는 한 번만 한다.
  pending ??= selectPool();
  try {
    activePool = await pending;
    return activePool;
  } catch (err) {
    // 실패를 캐싱하면 네트워크가 돌아와도 계속 실패한다. 다음 요청에서 다시 시도한다.
    pending = null;
    throw err;
  }
}

const pool = {
  async query(...args) {
    return (await getPool()).query(...args);
  },
  async connect() {
    return (await getPool()).connect();
  },
  async end() {
    if (activePool) await activePool.end();
    activePool = null;
    pending = null;
  }
};

// 서버 기동 시 DB에 실제로 닿는지 확인한다. 실패하면 예외를 그대로 던져 호출부가 판단한다.
export async function testConnection() {
  const result = await pool.query('SELECT now() AS now, current_database() AS db');
  return result.rows[0];
}

// 종료 신호를 받았을 때 열린 연결을 정리한다.
export async function closePool() {
  await pool.end();
}

export default pool;
