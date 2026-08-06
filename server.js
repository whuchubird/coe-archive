// Express 진입점. 정적 파일 서빙 + API 라우터 마운트 + 공통 에러 처리.
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import { testConnection, closePool } from './db/pool.js';
import beansRouter, { processesRouter } from './routes/beans.js';
import authRouter from './routes/auth.js';
import notesRouter from './routes/notes.js';
import favoritesRouter from './routes/favorites.js';
import statsRouter from './routes/stats.js';
import recommendRouter from './routes/recommend.js';
import adminRouter from './routes/admin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 3000;
const isProduction = process.env.NODE_ENV === 'production';

if (!process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET이 없다. .env.example을 .env로 복사해 값을 채운다.');
}

const app = express();

// Render는 리버스 프록시 뒤에서 돌아간다. secure 쿠키를 쓰려면 프록시를 신뢰해야 한다.
if (isProduction) {
  app.set('trust proxy', 1);
}

// public/ 아래 HTML·CSS·JS를 그대로 내보낸다.
// 세션·본문 파싱보다 먼저 둔다. 정적 파일에는 세션이 필요 없는데,
// 뒤에 두면 CSS·JS 요청 하나마다 세션 저장소를 한 번씩 들여다보게 된다.
app.use(express.static(path.join(__dirname, 'public')));

// 요청 본문 JSON 파싱. 폼은 전부 fetch로 JSON을 보낸다.
app.use(express.json());

// CSRF 방어 보강. 브라우저는 다른 사이트에서 시작된 요청에 Origin 헤더를 붙인다.
// Origin이 있는데 이 서버가 아니라면 남의 페이지가 시킨 요청이므로 막는다.
// curl처럼 Origin을 아예 보내지 않는 클라이언트는 그대로 통과시켜 테스트 스크립트를 깨뜨리지 않는다.
// (sameSite: 'lax' 쿠키가 1차 방어이고 이건 2차 방어다)
const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

app.use((req, res, next) => {
  if (!STATE_CHANGING_METHODS.has(req.method)) return next();

  const origin = req.get('origin');
  if (!origin) return next();

  if (origin === `${req.protocol}://${req.get('host')}`) return next();

  res.status(403).json({ error: '허용되지 않은 출처의 요청입니다.' });
});

// 세션: 쿠키에는 세션 ID만 담고 로그인 정보는 서버가 들고 있는다.
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,            // 변경이 없으면 다시 저장하지 않는다
  saveUninitialized: false, // 로그인 전 방문자에게는 세션을 만들지 않는다
  cookie: {
    httpOnly: true,         // JS에서 쿠키를 읽지 못하게 막는다 (XSS 방어)
    sameSite: 'lax',        // 다른 사이트에서 넘어온 요청에는 쿠키를 싣지 않는다 (CSRF 방어)
    secure: isProduction,   // 배포 환경에서는 HTTPS로만 전송
    maxAge: 1000 * 60 * 60 * 24 * 7 // 7일
  }
}));

// --- API 라우터 마운트 ---------------------------------------------
app.use('/api/beans', beansRouter);
// 가공방식 목록은 경로가 /api/beans 아래가 아니라 별도라 따로 붙인다.
app.use('/api/processes', processesRouter);

app.use('/api/auth', authRouter);
// notes·favorites는 라우터 안에서 requireAuth를 먼저 통과시킨다.
app.use('/api/notes', notesRouter);
app.use('/api/favorites', favoritesRouter);
// 통계는 /my만 로그인이 필요해 라우터 안에서 해당 경로에만 requireAuth를 건다.
app.use('/api/stats', statsRouter);
// 추천은 내 노트가 있어야 성립하므로 라우터 전체가 로그인 필요다.
app.use('/api/recommend', recommendRouter);
// 관리자 API는 라우터 전체에 requireAdmin이 걸려 있다.
// 화면에서 메뉴를 숨기는 것과 별개로, 서버가 매 요청 권한을 확인한다.
app.use('/api/admin', adminRouter);
// -------------------------------------------------------------------

// 정적 파일도 라우터도 처리하지 못한 요청.
app.use((req, res) => {
  res.status(404).json({ error: '요청한 경로를 찾을 수 없습니다.' });
});

// DB에 닿지 못해 생긴 오류인지 판단한다. 포트가 막혔거나 호스트가 응답하지 않는 경우다.
const DB_UNREACHABLE_CODES = new Set([
  'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'EHOSTUNREACH'
]);

// 오류 코드와 메시지를 보고 "DB에 못 닿은 것"인지 가려낸다.
// 코드 결함(500)과 일시적 단절(503)을 다르게 답하기 위해 필요하다.
function isDatabaseUnreachable(err) {
  if (DB_UNREACHABLE_CODES.has(err.code) || DB_UNREACHABLE_CODES.has(err.cause?.code)) return true;
  return /connection timeout|Connection terminated/i.test(err.message ?? '');
}

// 에러 핸들러는 인자가 4개여야 Express가 알아본다.
// 4xx는 요청이 잘못된 것이고 5xx는 서버 문제다. 원인이 다른데 같은 문구를 내보내면
// 클라이언트가 자기 잘못을 서버 탓으로 오해한다.
app.use((err, req, res, _next) => {
  // JSON 파싱 실패처럼 미들웨어가 던진 에러는 상태 코드를 직접 들고 온다.
  const status = err.status ?? err.statusCode ?? 500;

  // DB에 닿지 못한 것은 서버 코드의 결함이 아니라 일시적인 상태다.
  // 500 대신 503으로 답해 클라이언트가 "잠시 후 다시"를 판단할 수 있게 한다.
  if (isDatabaseUnreachable(err)) {
    console.error('[db]', err.message);
    return res.status(503).json({
      error: '데이터베이스에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.'
    });
  }

  if (status >= 500) {
    console.error('[error]', err);
    // 내부 오류 내용은 클라이언트에 노출하지 않는다.
    return res.status(status).json({ error: '서버 오류가 발생했습니다.' });
  }

  // 잘못된 요청은 서버 장애가 아니므로 스택까지 남기지 않는다.
  console.warn(`[${status}] ${req.method} ${req.originalUrl} — ${err.message}`);
  const message = err.type === 'entity.too.large'
    ? '요청 본문이 너무 큽니다.'
    : '요청 형식이 올바르지 않습니다.';
  res.status(status).json({ error: message });
});

const server = app.listen(PORT, () => {
  console.log(`[server] http://localhost:${PORT}`);
});

// DB 상태 확인은 서버 기동을 막지 않게 백그라운드에서 수행한다.
// DB가 느리거나 잠깐 끊겨도 정적 페이지와 오류 안내는 즉시 열려야 한다.
testConnection()
  .then((info) => {
    console.log(`[db] 연결 확인 (${info.db}, ${info.now.toISOString()})`);
  })
  .catch((err) => {
    console.error('[db] 연결 실패 —', err.message);
    console.error('[db] 정적 페이지는 그대로 열리고, API는 연결될 때까지 503을 돌려준다.');
    console.error('[db] 5432가 막힌 네트워크라면 .env에 DB_DRIVER=neon을 넣어 443으로 붙일 수 있다.');
  });

// 종료 신호를 받으면 새 요청을 끊고 DB 풀까지 정리한다.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(async () => {
      await closePool();
      process.exit(0);
    });
  });
}
