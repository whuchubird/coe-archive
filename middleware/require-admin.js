// 인가(authorization) 계층.
//
// requireAuth(routes/auth.js)와 일부러 파일을 나눴다. 둘은 묻는 질문이 다르다.
//   requireAuth  — 누구인가?      세션에 userId가 있는가
//   requireAdmin — 무엇을 할 수 있는가?  그 사용자의 role이 admin인가
//
// 클라이언트에서 메뉴를 감추는 것으로 끝내지 않는다.
// 주소를 직접 치거나 curl로 부르면 화면은 건너뛰므로, 판정은 서버에서만 한다.
import pool from '../db/pool.js';

// 권한을 세션에 담아 두지 않고 요청마다 DB에서 읽는다.
// 세션에 넣어 두면 관리자 권한을 회수해도 그 사람이 다시 로그인할 때까지 유지된다.
// 조회는 기본키 한 건이라 비용이 크지 않다.
export async function requireAdmin(req, res, next) {
  // 로그인부터 안 되어 있으면 권한을 따질 것도 없다. 401과 403은 뜻이 다르다.
  //   401 — 누구인지 모르겠다 (로그인하면 될 수도 있다)
  //   403 — 누구인지는 알지만 이 일은 할 수 없다
  if (!req.session.userId) {
    return res.status(401).json({ error: '로그인이 필요합니다.' });
  }

  const { rows } = await pool.query(
    'SELECT role FROM users WHERE id = $1',
    [req.session.userId]
  );

  // 세션은 남아 있는데 계정이 지워진 경우. 로그인 상태로 볼 수 없다.
  if (rows.length === 0) {
    return res.status(401).json({ error: '로그인이 필요합니다.' });
  }

  if (rows[0].role !== 'admin') {
    return res.status(403).json({ error: '관리자만 접근할 수 있습니다.' });
  }

  next();
}

export default requireAdmin;
