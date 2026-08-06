// /api/auth — 회원가입·로그인·로그아웃·로그인 상태 확인.
// 비밀번호는 bcrypt 해시만 저장하고, 로그인 상태는 세션에 userId 하나만 담는다.
import express from 'express';
import bcrypt from 'bcrypt';
import pool from '../db/pool.js';

const router = express.Router();

const SALT_ROUNDS = 10;

const USERNAME_MIN = 3;
const USERNAME_MAX = 20;
const PASSWORD_MIN = 8;
// bcrypt는 72바이트를 넘는 입력을 조용히 잘라낸다. 잘린 줄 모르고 쓰면
// 앞 72바이트만 같아도 로그인이 되므로, 미리 막고 사용자에게 알린다.
const PASSWORD_MAX_BYTES = 72;

// 로그인 실패 시 아이디가 있는지 없는지 구분되지 않도록 같은 문구를 쓴다.
const LOGIN_FAILED = '아이디 또는 비밀번호가 올바르지 않습니다.';

// 로그인 실패가 반복되면 잠시 막는다. 비밀번호를 하나씩 넣어 보는 시도를 늦추기 위한 것이다.
// 저장소가 프로세스 메모리라 서버를 재시작하면 초기화되고 인스턴스끼리 공유되지도 않는다.
// 완전한 방어가 아니라 속도를 떨어뜨리는 장치라는 점을 보고서에 함께 적는다.
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_BLOCK_MS = 10 * 60 * 1000;
const LOGIN_ATTEMPTS_MAX_KEYS = 1000;

// 키 → { count, firstAt, blockedUntil }
const loginAttempts = new Map();

// IP와 아이디를 함께 키로 쓴다.
// 아이디만으로 세면 남이 일부러 틀려서 특정 계정을 잠글 수 있다.
function attemptKey(req, username) {
  return `${req.ip}:${username.trim().toLowerCase()}`;
}

// 창이 지난 기록은 버린다. Map이 계속 커지지 않게 가끔 훑어 정리한다.
function pruneAttempts(now) {
  if (loginAttempts.size <= LOGIN_ATTEMPTS_MAX_KEYS) return;
  for (const [key, entry] of loginAttempts) {
    if (now > entry.blockedUntil && now - entry.firstAt > LOGIN_WINDOW_MS) {
      loginAttempts.delete(key);
    }
  }
}

// 아직 차단 중이면 남은 시간(초)을, 아니면 0을 돌려준다.
function blockedSeconds(key) {
  const entry = loginAttempts.get(key);
  if (!entry) return 0;
  const remaining = entry.blockedUntil - Date.now();
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}

// 실패를 한 번 기록한다. 창 안에서 정해진 횟수를 넘기면 차단 시각을 건다.
function recordFailure(key) {
  const now = Date.now();
  const entry = loginAttempts.get(key);

  // 기록이 없거나 창이 지났으면 새로 센다.
  if (!entry || now - entry.firstAt > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, firstAt: now, blockedUntil: 0 });
    pruneAttempts(now);
    return;
  }

  entry.count += 1;
  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    entry.blockedUntil = now + LOGIN_BLOCK_MS;
    entry.count = 0;
    entry.firstAt = now;
  }
}

// 로그인에 성공하면 그동안의 실패 기록을 지운다.
function clearFailures(key) {
  loginAttempts.delete(key);
}

// 존재하지 않는 아이디일 때도 해시 비교와 비슷한 시간을 쓰기 위한 더미 해시.
// 응답이 빨리 돌아오는 것만으로 "그 아이디는 없다"가 새어나가는 것을 막는다.
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', SALT_ROUNDS);

// ============================================================
// 세션 도우미 — 콜백 API를 async/await에서 쓰기 위해 감싼다.
// ============================================================

// 로그인 직후 세션 ID를 새로 발급한다.
// 로그인 전에 쓰던 ID를 그대로 유지하면, 공격자가 미리 심어둔 세션 ID로
// 로그인된 상태를 그대로 넘겨받을 수 있다(세션 고정 공격).
function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}

// 로그아웃 시 세션을 저장소에서 완전히 지운다.
function destroySession(req) {
  return new Promise((resolve, reject) => {
    req.session.destroy((err) => (err ? reject(err) : resolve()));
  });
}

// ============================================================
// 입력 검증
// ============================================================

// 가입 입력값을 확인한다. 문제가 있으면 사용자에게 보여줄 메시지를, 없으면 null을 돌려준다.
function validateCredentials(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string') {
    return '아이디와 비밀번호를 모두 입력해 주세요.';
  }
  const trimmed = username.trim();
  if (trimmed.length < USERNAME_MIN || trimmed.length > USERNAME_MAX) {
    return `아이디는 ${USERNAME_MIN}~${USERNAME_MAX}자로 입력해 주세요.`;
  }
  if (password.length < PASSWORD_MIN) {
    return `비밀번호는 ${PASSWORD_MIN}자 이상이어야 합니다.`;
  }
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
    return '비밀번호가 너무 깁니다. 더 짧게 입력해 주세요.';
  }
  return null;
}

// ============================================================
// 라우터
// ============================================================

// 회원가입. 아이디 중복은 DB의 UNIQUE 제약으로 판정한다.
// 먼저 SELECT로 확인하고 INSERT하면 그 사이에 같은 아이디가 들어올 수 있어,
// ON CONFLICT로 한 번에 처리하고 반환된 행이 없으면 중복으로 본다.
router.post('/register', async (req, res) => {
  // 본문에서 아이디와 비밀번호만 꺼낸다.
  // 클라이언트가 { role: "admin" }을 같이 보내도 여기서 읽지 않고,
  // 아래 INSERT의 컬럼 목록에도 role이 없어 DB에는 기본값 'user'만 들어간다.
  // 관리자 지정은 `npm run make-admin -- 아이디` 로만 한다.
  const { username, password } = req.body ?? {};

  const message = validateCredentials(username, password);
  if (message) return res.status(400).json({ error: message });

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  let rows;
  try {
    // 대소문자만 다른 아이디도 같은 것으로 본다.
    // 판정은 users(lower(username)) 유일 인덱스가 하고, 표기는 입력한 그대로 저장한다.
    ({ rows } = await pool.query(
      `INSERT INTO users (username, password_hash)
       VALUES ($1, $2)
       RETURNING id, username, role`,
      [username.trim(), passwordHash]
    ));
  } catch (err) {
    // 23505 = 유일 제약 위반. 먼저 SELECT로 확인하고 INSERT하면 그 사이에 끼어들 수 있어
    // DB 제약에 판정을 맡기고 여기서 결과만 해석한다.
    if (err.code === '23505') {
      return res.status(409).json({ error: '이미 사용 중인 아이디입니다.' });
    }
    throw err;
  }

  // 가입 직후 바로 로그인 상태로 만든다.
  await regenerateSession(req);
  req.session.userId = rows[0].id;

  res.status(201).json({ authenticated: true, user: rows[0] });
});

// 로그인. 해시를 직접 비교하지 않고 bcrypt.compare에 맡긴다.
router.post('/login', async (req, res) => {
  const { username, password } = req.body ?? {};

  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: '아이디와 비밀번호를 모두 입력해 주세요.' });
  }

  // 같은 IP에서 같은 아이디로 계속 실패했으면 잠시 받지 않는다.
  const key = attemptKey(req, username);
  const waitSeconds = blockedSeconds(key);
  if (waitSeconds > 0) {
    return res.status(429).json({
      error: `로그인 시도가 너무 많습니다. ${waitSeconds}초 후 다시 시도해 주세요.`
    });
  }

  // 가입 단계에서 받을 수 없는 72바이트 초과 비밀번호는 로그인에서도 거부한다.
  // 비교 시간을 비슷하게 유지하면서, bcrypt의 72바이트 절단으로 인증되는 일을 막는다.
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
    await bcrypt.compare(password, DUMMY_HASH);
    recordFailure(key);
    return res.status(401).json({ error: LOGIN_FAILED });
  }

  // 가입 때와 같은 기준으로 찾는다. lower(username) 인덱스가 이 조건을 그대로 받는다.
  const { rows } = await pool.query(
    'SELECT id, username, role, password_hash FROM users WHERE lower(username) = lower($1)',
    [username.trim()]
  );

  const user = rows[0];
  // 아이디가 없어도 해시 비교를 한 번 돌려 응답 시간 차이를 없앤다.
  const matched = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);

  if (!user || !matched) {
    recordFailure(key);
    return res.status(401).json({ error: LOGIN_FAILED });
  }

  clearFailures(key);
  await regenerateSession(req);
  req.session.userId = user.id;

  // 해시는 절대 응답에 담지 않는다. 필요한 필드만 골라 내보낸다.
  res.json({ authenticated: true, user: { id: user.id, username: user.username, role: user.role } });
});

// 로그아웃. 세션을 지우고 브라우저 쿠키도 함께 정리한다.
router.post('/logout', async (req, res) => {
  await destroySession(req);
  res.clearCookie('connect.sid');
  res.json({ authenticated: false });
});

// 로그인 상태 확인. 비로그인도 정상 상태이므로 401이 아니라 200으로 답한다.
// 세션에 남은 userId가 이미 지워진 계정을 가리킬 수 있어 DB에서 다시 확인한다.
router.get('/me', async (req, res) => {
  if (!req.session.userId) {
    return res.json({ authenticated: false, user: null });
  }

  // role까지 함께 내려 화면이 관리자 메뉴를 보일지 판단할 수 있게 한다.
  // 다만 화면에서 감추는 것은 편의일 뿐이고, 실제 판정은 requireAdmin이 서버에서 한다.
  const { rows } = await pool.query(
    'SELECT id, username, role FROM users WHERE id = $1',
    [req.session.userId]
  );

  if (rows.length === 0) {
    await destroySession(req);
    return res.json({ authenticated: false, user: null });
  }

  res.json({ authenticated: true, user: rows[0] });
});

// 로그인이 필요한 라우터 앞에 세운다. 세션의 userId와 실제 계정 존재 여부를 함께 확인한다.
// notes·favorites는 이 미들웨어를 통과한 뒤에만 실행되므로,
// 각 핸들러는 유효한 req.session.userId가 있다고 믿고 쿼리를 짤 수 있다.
export async function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: '로그인이 필요합니다.' });
  }

  // 관리자가 계정을 삭제해도 그 사용자의 브라우저에는 세션 쿠키가 남아 있을 수 있다.
  // 세션의 userId만 믿으면 삭제된 계정이 다음 /me 요청 전까지 인증 라우터를 통과하므로,
  // 보호된 요청마다 실제 계정이 아직 존재하는지 확인한다.
  const { rowCount } = await pool.query(
    'SELECT 1 FROM users WHERE id = $1',
    [req.session.userId]
  );
  if (rowCount === 0) {
    await destroySession(req);
    return res.status(401).json({ error: '로그인이 필요합니다.' });
  }

  next();
}

export default router;
