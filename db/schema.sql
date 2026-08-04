-- COE ARCHIVE 테이블 정의 (DDL)
-- 실행: npm run db:reset  → 이 파일을 적용한 뒤 시딩까지 이어서 한다.
-- 주의: 아래 DROP은 기존 데이터를 모두 지운다. 사용자 계정·노트·즐겨찾기도 함께 사라진다.

-- ============================================================
-- 1) 삭제 — 외래키 의존성 역순으로. 자식 테이블을 먼저 지운다.
-- ============================================================
DROP TABLE IF EXISTS favorites      CASCADE;
DROP TABLE IF EXISTS notes          CASCADE;
DROP TABLE IF EXISTS users          CASCADE;
DROP TABLE IF EXISTS bean_flavors   CASCADE;
DROP TABLE IF EXISTS flavor_notes   CASCADE;
DROP TABLE IF EXISTS bean_buyers    CASCADE;
DROP TABLE IF EXISTS buyers         CASCADE;
DROP TABLE IF EXISTS bean_varieties CASCADE;
DROP TABLE IF EXISTS varieties      CASCADE;
DROP TABLE IF EXISTS sensory        CASCADE;
DROP TABLE IF EXISTS beans          CASCADE;
DROP TABLE IF EXISTS processes      CASCADE;

-- ============================================================
-- 2) 생성 — 부모 테이블부터. 참조 대상이 먼저 존재해야 한다.
-- ============================================================

-- 가공방식 마스터. beans가 참조하므로 가장 먼저 만든다.
CREATE TABLE processes (
  key          TEXT PRIMARY KEY,        -- washed, honey, pulped-natural, natural, experimental
  name_ko      TEXT NOT NULL,
  name_en      TEXT NOT NULL,
  summary      TEXT,
  detail       TEXT,
  acidity      SMALLINT,                -- 가이드 페이지 비교표용 (1~5)
  body         SMALLINT,
  sweetness    SMALLINT,
  cleanliness  SMALLINT
);

-- 수상 로트 본체. 모든 조회의 중심 테이블.
CREATE TABLE beans (
  id               TEXT PRIMARY KEY,    -- BR25W01 같은 로트 코드
  farm             TEXT NOT NULL,
  farmer           TEXT,
  country          TEXT NOT NULL,
  country_ko       TEXT NOT NULL,
  region           TEXT,
  year             SMALLINT NOT NULL,
  award            TEXT NOT NULL,       -- COE | NW
  rank             SMALLINT,            -- NW 로트는 순위가 없어 NULL
  category         TEXT,
  category_ko      TEXT,
  score            NUMERIC(5,2) NOT NULL,
  process_key      TEXT NOT NULL REFERENCES processes(key),
  bid_per_lb       NUMERIC(8,2),
  weight_lb        NUMERIC(9,2),
  total_value_usd  NUMERIC(12,2),
  has_korean_buyer BOOLEAN DEFAULT FALSE
);

-- 감각 6축 (beans와 1:1). 로트가 지워지면 같이 지운다.
-- 주의: 공식 데이터가 아니라 가공방식·품종·총점 기반 추정치다.
CREATE TABLE sensory (
  bean_id     TEXT PRIMARY KEY REFERENCES beans(id) ON DELETE CASCADE,
  aroma       NUMERIC(2,1),
  acidity     NUMERIC(2,1),
  body        NUMERIC(2,1),
  sweetness   NUMERIC(2,1),
  aftertaste  NUMERIC(2,1),
  balance     NUMERIC(2,1)
);

-- 품종 마스터. 한 로트에 여러 품종이 오므로 별도 테이블로 분리했다.
CREATE TABLE varieties (
  id   SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL
);

-- 로트 ↔ 품종 (M:N). 복합 기본키로 같은 조합이 두 번 들어가지 않게 막는다.
CREATE TABLE bean_varieties (
  bean_id    TEXT    NOT NULL REFERENCES beans(id) ON DELETE CASCADE,
  variety_id INTEGER NOT NULL REFERENCES varieties(id) ON DELETE CASCADE,
  PRIMARY KEY (bean_id, variety_id)
);

-- 낙찰 업체 마스터. "특정 업체가 낙찰한 로트" 역방향 조회를 위해 분리했다.
CREATE TABLE buyers (
  id        SERIAL PRIMARY KEY,
  name      TEXT UNIQUE NOT NULL,
  is_korean BOOLEAN DEFAULT FALSE
);

-- 로트 ↔ 낙찰 업체 (M:N). 공동 낙찰이 있어 한 로트에 여러 업체가 붙는다.
CREATE TABLE bean_buyers (
  bean_id  TEXT    NOT NULL REFERENCES beans(id) ON DELETE CASCADE,
  buyer_id INTEGER NOT NULL REFERENCES buyers(id) ON DELETE CASCADE,
  PRIMARY KEY (bean_id, buyer_id)
);

-- 향미 키워드 마스터. 중복 문자열을 한 곳에 모아 태그 검색을 가능하게 한다.
CREATE TABLE flavor_notes (
  id   SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL
);

-- 로트 ↔ 향미 (M:N).
CREATE TABLE bean_flavors (
  bean_id   TEXT    NOT NULL REFERENCES beans(id) ON DELETE CASCADE,
  flavor_id INTEGER NOT NULL REFERENCES flavor_notes(id) ON DELETE CASCADE,
  PRIMARY KEY (bean_id, flavor_id)
);

-- 사용자. 비밀번호는 bcrypt 해시만 저장한다. 평문은 어디에도 남기지 않는다.
CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- 테이스팅 노트. users와 beans 양쪽에서 1:N으로 물린다.
-- 회원 탈퇴 시 노트도 함께 지우지만, 로트는 지워질 일이 없어 CASCADE를 걸지 않았다.
CREATE TABLE notes (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bean_id     TEXT    NOT NULL REFERENCES beans(id),
  brew_method TEXT,
  rating      SMALLINT CHECK (rating BETWEEN 1 AND 5),
  comment     TEXT,
  aroma       NUMERIC(2,1),
  acidity     NUMERIC(2,1),
  body        NUMERIC(2,1),
  sweetness   NUMERIC(2,1),
  aftertaste  NUMERIC(2,1),
  balance     NUMERIC(2,1),
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- 즐겨찾기. 복합 기본키라 같은 사용자가 같은 로트를 두 번 담을 수 없다.
-- 중복 방지를 애플리케이션 코드가 아니라 DB 제약으로 보장하는 것이 요점이다.
CREATE TABLE favorites (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bean_id    TEXT    NOT NULL REFERENCES beans(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, bean_id)
);

-- ============================================================
-- 3) 인덱스 — 정렬·필터에 실제로 쓰이는 컬럼에만 건다.
-- ============================================================

-- 기본 정렬(점수 높은 순)과 낙찰가 정렬
CREATE INDEX idx_beans_score  ON beans (score DESC);
CREATE INDEX idx_beans_bid    ON beans (bid_per_lb DESC);

-- 체크박스 필터가 걸리는 컬럼
CREATE INDEX idx_beans_process ON beans (process_key);
CREATE INDEX idx_beans_country ON beans (country);

-- 내 노트 목록: user_id로 거르고 최신순 정렬. 두 컬럼을 한 인덱스로 함께 처리한다.
CREATE INDEX idx_notes_user_created ON notes (user_id, created_at DESC);

-- 아이디는 대소문자를 구분하지 않는다. 'coe'로 가입했으면 'COE'로는 가입할 수 없다.
-- users.username의 UNIQUE 제약은 글자가 정확히 같을 때만 막아 주므로,
-- 소문자로 바꾼 값에 유일 인덱스를 하나 더 걸어 DB가 판정하게 한다.
-- 로그인의 WHERE lower(username) = lower($1)도 이 인덱스를 그대로 쓴다.
CREATE UNIQUE INDEX idx_users_username_lower ON users (lower(username));
