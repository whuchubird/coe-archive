// pg 커넥션 풀을 한 번만 만들어 앱 전체가 공유한다.
// 라우터마다 새 연결을 여는 대신 풀에서 빌려 쓰고 반납한다.
import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL이 없다. .env.example을 .env로 복사해 값을 채운다.');
}

// 로컬 PostgreSQL은 평문 연결이지만 Neon은 TLS만 허용한다. 호스트를 보고 판단한다.
const isLocalHost = /@(localhost|127\.0\.0\.1)/.test(connectionString);

// rejectUnauthorized: true — 서버 인증서를 실제로 검증한다.
// Neon 인증서는 공인 CA가 발급하므로 그대로 통과한다.
// (자체 서명 인증서를 쓰는 DB로 옮기면 이 값 때문에 연결이 막힌다)
const ssl = isLocalHost ? false : { rejectUnauthorized: true };

const pool = new Pool({
  connectionString,
  ssl,
  max: 10,                        // Neon 무료 플랜의 동시 연결 한도를 넘지 않게
  idleTimeoutMillis: 30_000,      // 노는 연결은 30초 뒤 반납
  connectionTimeoutMillis: 10_000 // 연결이 10초 넘게 안 잡히면 실패 처리
});

// 풀이 들고 있던 유휴 연결이 끊겨도 프로세스가 죽지 않도록 잡아둔다.
pool.on('error', (err) => {
  console.error('[db] 유휴 연결 오류:', err.message);
});

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
