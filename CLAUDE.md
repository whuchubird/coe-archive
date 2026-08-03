# COE ARCHIVE — 프로젝트 명세 (풀스택)

Cup of Excellence 2025 수상 커피 아카이브. 대학 「동적웹프로그래밍」 과제 프로젝트.
클라이언트 · 서버 · 데이터베이스 3계층 구조.

---

## 기술 스택

| 계층 | 기술 |
|---|---|
| 프론트엔드 | HTML5, CSS3, Vanilla JavaScript (ES6+), 멀티페이지 |
| 백엔드 | Node.js 20, Express 5 |
| 데이터베이스 | PostgreSQL (Neon 서버리스) |
| DB 드라이버 | `pg` (node-postgres) — ORM 없이 SQL 직접 작성 |
| 인증 | `express-session` + `bcrypt` |
| 배포 | 애플리케이션 Render, 데이터베이스 Neon |

## 원칙

- **프론트엔드는 프레임워크 없이 간다.** React·Vue 금지. 과제 결과보고서가 `index.html`, `main.html` 처럼 **페이지별로 HTML·CSS·JavaScript를 나눠 설명**하도록 요구하므로, 멀티페이지 + 바닐라 JS 구조가 문서 작성에 유리하다. 기술적 한계가 아니라 의도된 선택이다.
- **ORM을 쓰지 않는다.** Prisma·Sequelize 대신 `pg`로 SQL을 직접 작성한다. SQL 자체가 보고서에 쓸 내용이고, JOIN·집계 쿼리를 설명할 수 있어야 DB 활용이 인정된다.
- **차트 라이브러리를 쓰지 않는다.** 레이더·산점도·도넛은 SVG를 JS로 직접 생성한다.
- **필터링·정렬·페이지네이션은 서버에서 SQL로 처리한다.** 프론트에서 전체 데이터를 받아 `filter()`로 거르지 않는다. 이게 정적 사이트와의 핵심 차이점이고, 보고서에서 가장 강조할 부분이다.
- 그 외 라이브러리는 필요하면 쓰되, **왜 필요한지 설명할 수 있는 것만** 추가한다.

## 코드 작성 규칙

- 주석은 **한국어**로. 각 함수·라우터·쿼리 위에 "무엇을 왜" 한 줄.
- 함수는 한 가지 일만 한다.
- `var` 금지. `const` 기본.
- **SQL은 반드시 파라미터 바인딩**(`$1`, `$2`)을 쓴다. 문자열 결합으로 쿼리를 만들지 않는다 — SQL 인젝션 방어는 보고서 항목이다.
- 비밀번호는 `bcrypt`로 해싱한다. 평문 저장 금지.
- 세션 쿠키는 `httpOnly: true`.
- DB 접속 정보는 `.env`에 두고 `.gitignore`에 등록한다. **커밋에 절대 포함하지 않는다.**
- 프론트에서 사용자 입력을 출력할 때 `innerHTML` 대신 `textContent`를 쓴다.

---

## 파일 구조

```
coe-archive/
├── server.js               Express 진입점
├── package.json
├── .env                    DATABASE_URL, SESSION_SECRET (커밋 금지)
├── .env.example            키 이름만 담은 샘플 (커밋함)
├── .gitignore
├── db/
│   ├── pool.js             pg Pool 생성 및 공유
│   ├── schema.sql          테이블 정의 (DDL)
│   └── seed.js             beans.json → DB 적재
├── routes/
│   ├── beans.js            /api/beans
│   ├── notes.js            /api/notes
│   ├── auth.js             /api/auth
│   ├── favorites.js        /api/favorites
│   └── stats.js            /api/stats
├── data/
│   └── beans.json          시딩 원본 (COE 2025, 74건)
└── public/                 Express가 정적 서빙
    ├── index.html  beans.html  detail.html  notes.html
    ├── stats.html  guide.html  brew.html  login.html
    ├── css/    common.css  page.css
    └── js/     common.js  api.js  chart.js  [페이지명].js
```

---

## 데이터베이스 스키마

정규화된 10개 테이블. 1:1, 1:N, M:N 관계를 모두 포함한다.

```sql
-- 가공방식 (마스터)
processes (
  key          TEXT PRIMARY KEY,        -- washed, honey, natural, ...
  name_ko      TEXT NOT NULL,
  name_en      TEXT NOT NULL,
  summary      TEXT,
  detail       TEXT,
  acidity      SMALLINT,                -- 가이드 페이지 비교표용
  body         SMALLINT,
  sweetness    SMALLINT,
  cleanliness  SMALLINT
)

-- 수상 로트 (본체)
beans (
  id               TEXT PRIMARY KEY,    -- GT25W01
  farm             TEXT NOT NULL,
  farmer           TEXT,
  country          TEXT NOT NULL,
  country_ko       TEXT NOT NULL,
  region           TEXT,
  year             SMALLINT NOT NULL,
  award            TEXT NOT NULL,       -- COE | NW
  rank             SMALLINT,            -- NW는 NULL
  category         TEXT,
  category_ko      TEXT,
  score            NUMERIC(5,2) NOT NULL,
  process_key      TEXT NOT NULL REFERENCES processes(key),
  bid_per_lb       NUMERIC(8,2),
  weight_lb        NUMERIC(9,2),
  total_value_usd  NUMERIC(12,2),
  has_korean_buyer BOOLEAN DEFAULT FALSE
)

-- 감각 프로필 (1:1)
sensory (
  bean_id     TEXT PRIMARY KEY REFERENCES beans(id) ON DELETE CASCADE,
  aroma       NUMERIC(2,1), acidity NUMERIC(2,1), body NUMERIC(2,1),
  sweetness   NUMERIC(2,1), aftertaste NUMERIC(2,1), balance NUMERIC(2,1)
)

-- 품종 (M:N)
varieties      (id SERIAL PK, name TEXT UNIQUE)
bean_varieties (bean_id FK, variety_id FK, PRIMARY KEY (bean_id, variety_id))

-- 낙찰 업체 (M:N)
buyers      (id SERIAL PK, name TEXT UNIQUE, is_korean BOOLEAN DEFAULT FALSE)
bean_buyers (bean_id FK, buyer_id FK, PRIMARY KEY (bean_id, buyer_id))

-- 향미 키워드 (M:N)
flavor_notes  (id SERIAL PK, name TEXT UNIQUE)
bean_flavors  (bean_id FK, flavor_id FK, PRIMARY KEY (bean_id, flavor_id))

-- 사용자
users (
  id            SERIAL PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now()
)

-- 테이스팅 노트 (1:N × 2)
notes (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bean_id     TEXT NOT NULL REFERENCES beans(id),
  brew_method TEXT,
  rating      SMALLINT CHECK (rating BETWEEN 1 AND 5),
  comment     TEXT,
  aroma NUMERIC(2,1), acidity NUMERIC(2,1), body NUMERIC(2,1),
  sweetness NUMERIC(2,1), aftertaste NUMERIC(2,1), balance NUMERIC(2,1),
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
)

-- 즐겨찾기 (복합 PK)
favorites (
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  bean_id TEXT REFERENCES beans(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, bean_id)
)
```

인덱스: `beans(score DESC)`, `beans(bid_per_lb DESC)`, `beans(process_key)`, `beans(country)`, `notes(user_id, created_at DESC)`.

**보고서에 쓸 설명 포인트** — 왜 품종·낙찰업체·향미를 별도 테이블로 분리했는지(다중값 속성, 중복 제거, "특정 업체가 낙찰한 로트" 역방향 조회 가능), 왜 favorites는 복합 기본키인지(중복 즐겨찾기 방지를 DB 제약으로 보장).

---

## API 명세

모든 응답은 JSON. 에러는 `{ error: "메시지" }` 형태와 적절한 상태 코드.

### 로트
```
GET  /api/beans
     ?country=Brazil,Guatemala   &award=COE       &process=natural,honey
     &variety=Geisha             &q=검색어         &minScore=88
     &minAcidity=4  &minBody=3   &minSweetness=3
     &sort=score|bid|value|rank  &order=asc|desc
     &page=1  &limit=12
     → { items: [...], total, page, totalPages, facets: {...} }

GET  /api/beans/:id          → 로트 상세 + 품종·업체·향미·감각 JOIN
GET  /api/beans/:id/similar  → 감각 6축 거리 기준 유사 로트 3건
GET  /api/processes          → 가공방식 5종
```

`facets`는 현재 필터 조건에서 각 옵션별 개수(예: 내추럴 25건). 체크박스 옆에 숫자를 띄우는 용도.

### 인증
```
POST /api/auth/register  { username, password }
POST /api/auth/login     { username, password }
POST /api/auth/logout
GET  /api/auth/me        → 로그인 상태 확인
```

### 노트 (로그인 필요)
```
GET    /api/notes        → 내 노트 목록 (bean JOIN, 최신순)
POST   /api/notes
PUT    /api/notes/:id
DELETE /api/notes/:id
```

남의 노트를 수정·삭제할 수 없도록 **모든 쿼리 WHERE에 `user_id`를 포함**한다. 보고서의 보안 항목이 된다.

### 즐겨찾기 (로그인 필요)
```
GET    /api/favorites
POST   /api/favorites/:beanId
DELETE /api/favorites/:beanId
```

### 통계
```
GET /api/stats/overview     → 총계, 평균 점수, 평균/최고 낙찰가
GET /api/stats/by-process   → 가공방식별 건수·평균 점수·평균 낙찰가 (GROUP BY)
GET /api/stats/by-country   → 국가별 집계
GET /api/stats/scatter      → 점수·낙찰가·가공방식 (산점도용)
GET /api/stats/varieties    → 품종 랭킹 (JOIN + GROUP BY + ORDER BY count)
GET /api/stats/korean       → 한국 업체 낙찰 로트 13건
GET /api/stats/my           → 내 노트 기반 취향 요약 (로그인 시)
```

**집계는 전부 SQL의 `GROUP BY`·`AVG`·`COUNT`로 처리한다.** 전체 행을 가져와 JS에서 `reduce`로 돌리지 않는다.

---

## 시딩 데이터

`data/beans.json` — ACE 공식 발표 기반 COE 2025 브라질·과테말라 74건.

| 항목 | 분포 |
|---|---|
| 국가 | 브라질 39 · 과테말라 35 |
| 등급 | COE 60 · NW 14 |
| 가공방식 | 내추럴 25 · 워시드 21 · 실험적 14 · 허니 8 · 펄프드 내추럴 6 |
| 점수 | 86.20 ~ 91.68 |
| 낙찰가 | $4.03 ~ $143.10 /lb |
| 한국 업체 낙찰 | 13건 |

`seed.js`는 **멱등하게** 만든다. 여러 번 실행해도 중복이 쌓이지 않도록 `ON CONFLICT DO NOTHING` 또는 선행 `TRUNCATE ... CASCADE`를 쓴다.

**반드시 사이트에 명시할 것** — 감각 6축(`sensory`)과 향미 키워드는 ACE 공식 공개 항목이 아니며 가공방식·품종·총점 기반 추정치다. 푸터와 통계 페이지에 표기한다. 나머지 항목은 모두 공식 데이터다.

---

## 디자인 방향

주제는 **볶기 전 생두(green coffee)를 거래하는 국제 경매**다. 카페 사이트가 아니다. 갈색·크림색·라떼아트로 가면 주제를 놓친 것이다. 화면의 성격은 **경매 로트 전표와 커핑 점수표**에 가깝다 — 숫자가 주인공이고, 여백이 정보를 정렬한다.

```css
--ink:   #16191A;   /* 본문·다크 배경 */
--paper: #EAEDE4;   /* 라이트 배경. 생두 마대 색 */
--raw:   #9FB07E;   /* 생두 세이지 그린. 점수·긍정 지표 */
--parch: #D3D2C2;   /* 구분선·비활성 */
--bid:   #1F4FD8;   /* 낙찰가·링크·포커스. 데이터 축 */
--flag:  #D64545;   /* 한국 낙찰 표시 등 소수의 강조 */
```

라이트 모드 기본. 다크 모드는 CSS 변수만 교환한다.

**서체**
```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css">
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet">
```
- **Instrument Serif** — 영문 제목, 농장명. 크게, 아껴서.
- **Pretendard** — 한글 본문·UI.
- **IBM Plex Mono** — 점수·낙찰가·중량·순위. 모든 숫자는 `font-variant-numeric: tabular-nums`로 세로 정렬.

**시그니처 — 로트 전표 카드.** 원두 카드는 상품 카드가 아니라 경매 전표처럼 생겼다. 좌측에 순위가 도장처럼, 농장명은 세리프, 점수는 큰 모노스페이스, 낙찰가는 `--bid` 색, 하단에 절취선(점선)과 로트 ID. `border-radius`는 2px 이하, 그림자 최소화. 과감함은 여기 한 곳에만 쓴다.

**품질 기준** — 3단계 반응형(640/1024), `:focus-visible` 표시, `prefers-reduced-motion` 존중, 시맨틱 태그, 원두 사진 미사용(저작권 회피 겸 의도된 선택).

---

## 페이지 명세

### index.html — 메인
히어로에 최고 낙찰가 로트, 추천 로트 캐러셀, 가공방식 5종 카드, 로그인 시 최근 노트 3건.

### beans.html — 아카이브 (핵심)
국가·등급·가공방식·품종 체크박스(옆에 facet 개수), 산미/바디/단맛 최소값 슬라이더, 검색(디바운스 300ms), 정렬 4종, 전표 카드 그리드, 페이지네이션.
**모든 조건을 쿼리스트링으로 만들어 `/api/beans`에 넘긴다.** 필터 상태는 브라우저 주소에도 반영해 새로고침·공유 시 유지.

### detail.html — 상세
`?id=`로 조회. 전체 정보, 감각 6축 SVG 레이더 차트, 향미 태그, 낙찰 업체, 즐겨찾기 토글, 유사 로트 3건, 노트 작성 연결.

### login.html — 로그인·회원가입
탭 전환 방식 한 페이지. 아이디 중복 확인, 비밀번호 8자 이상 검증, 에러 메시지 표시.

### notes.html — 나의 테이스팅 노트 (로그인 필요)
작성 폼(로트 선택, 추출 방식, 감각 슬라이더 6개, 별점, 코멘트), 유효성 검사, 목록, 수정·삭제 모달, 즐겨찾기 목록. 비로그인 시 login으로 유도.

### stats.html — 통계
가공방식별 도넛, **점수-낙찰가 산점도**(가공방식별 색, 낙찰가 편차가 커서 로그 스케일 고려), 국가별 평균 막대, 품종 랭킹, 한국 낙찰 13건, 로그인 시 내 취향 요약. 감각 추정치 안내 표기.

### guide.html — 가공방식 가이드
5종 아코디언, 특성 비교표, 각 방식 대표 로트 연결, sticky 목차 + 스크롤 스파이.

### brew.html — 추출 계산기
원두량 + 비율 슬라이더 → 물량 실시간 계산, 4단계 타이머와 진행바, 로트 선택 시 가공방식별 권장 비율 제안.

---

## 하지 말 것

- 명세에 없는 페이지·테이블을 임의로 추가하지 않는다
- SQL을 문자열 결합으로 만들지 않는다
- 비밀번호를 평문으로 저장하지 않는다
- `.env`를 커밋하지 않는다
- 전체 데이터를 프론트로 보내 클라이언트에서 필터링하지 않는다
- `sensory` 값을 공식 데이터인 것처럼 표시하지 않는다
- 존재하지 않는 로트를 지어내지 않는다 (74건이 전부)
