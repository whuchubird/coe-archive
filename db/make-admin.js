// 특정 사용자를 관리자로 지정한다.
//
//   npm run make-admin -- 아이디
//
// 회원가입으로는 관리자가 될 수 없으므로, 첫 관리자는 이 스크립트로만 만든다.
// 웹에 이 경로를 열지 않는 이유는 명세대로다 — 관리자 승격은 서버에 접근할 수 있는
// 사람만 할 수 있어야 한다.
import pool, { closePool } from './pool.js';

// npm은 `--` 뒤의 인자를 그대로 넘겨준다.
const args = process.argv.slice(2);
const username = args[0]?.trim();

function printUsage() {
  console.error('사용법: npm run make-admin -- 아이디');
  console.error('  예)  npm run make-admin -- coetester');
}

// 현재 등록된 계정을 보여준다. 아이디를 잘못 적었을 때 바로 알아채도록.
async function printUsers() {
  const { rows } = await pool.query(
    'SELECT username, role FROM users ORDER BY id'
  );
  if (rows.length === 0) {
    console.error('  등록된 계정이 없다.');
    return;
  }
  console.error('  등록된 계정:');
  for (const row of rows) console.error(`    ${row.username}  (${row.role})`);
}

async function main() {
  if (!username || args.length !== 1) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  // 로그인과 같은 기준으로 찾는다. 아이디는 대소문자를 구분하지 않는다.
  const { rows } = await pool.query(
    `UPDATE users
        SET role = $2
      WHERE lower(username) = lower($1)
      RETURNING id, username, role`,
    [username, 'admin']
  );

  if (rows.length === 0) {
    console.error(`'${username}' 계정을 찾을 수 없다.`);
    await printUsers();
    process.exitCode = 1;
    return;
  }

  const user = rows[0];
  console.log(`${user.username} 을(를) 관리자로 지정했다. (role=${user.role})`);

  // 관리자가 몇 명인지 함께 알려 준다.
  const { rows: admins } = await pool.query(
    "SELECT username FROM users WHERE role = 'admin' ORDER BY id"
  );
  console.log(`현재 관리자 ${admins.length}명: ${admins.map((a) => a.username).join(', ') || '(없음)'}`);
}

try {
  await main();
} catch (err) {
  console.error('실패:', err.message);
  // role 컬럼이 없으면 마이그레이션을 먼저 돌려야 한다.
  if (err.code === '42703') {
    console.error('users.role 컬럼이 없다. db/migration_v2.sql 을 먼저 적용한다.');
  }
  process.exitCode = 1;
} finally {
  await closePool();
}
