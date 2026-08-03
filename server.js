// Express 진입점. 정적 파일 서빙 + API 라우터 마운트 + 공통 에러 처리.
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import { testConnection, closePool } from './db/pool.js';

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

// 요청 본문 JSON 파싱. 폼은 전부 fetch로 JSON을 보낸다.
app.use(express.json());

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

// public/ 아래 HTML·CSS·JS를 그대로 내보낸다.
app.use(express.static(path.join(__dirname, 'public')));

// --- API 라우터 마운트 ---------------------------------------------
// 각 라우터 파일을 만들면 아래 주석을 푼다. import는 파일 상단으로 옮긴다.
// import beansRouter from './routes/beans.js';
// import authRouter from './routes/auth.js';
// import notesRouter from './routes/notes.js';
// import favoritesRouter from './routes/favorites.js';
// import statsRouter from './routes/stats.js';
//
// app.use('/api/beans', beansRouter);
// app.use('/api/auth', authRouter);
// app.use('/api/notes', notesRouter);
// app.use('/api/favorites', favoritesRouter);
// app.use('/api/stats', statsRouter);
// -------------------------------------------------------------------

// 정적 파일도 라우터도 처리하지 못한 요청.
app.use((req, res) => {
  res.status(404).json({ error: '요청한 경로를 찾을 수 없습니다.' });
});

// 에러 핸들러는 인자가 4개여야 Express가 알아본다.
app.use((err, req, res, _next) => {
  console.error('[error]', err);
  // 내부 오류 내용은 클라이언트에 노출하지 않는다.
  res.status(err.status || 500).json({ error: '서버 오류가 발생했습니다.' });
});

// DB에 실제로 닿는지 먼저 확인하고 서버를 띄운다.
const info = await testConnection();
console.log(`[db] 연결 확인 (${info.db}, ${info.now.toISOString()})`);

const server = app.listen(PORT, () => {
  console.log(`[server] http://localhost:${PORT}`);
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
