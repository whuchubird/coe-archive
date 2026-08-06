-- ============================================================
-- v2 마이그레이션 — 관리자 권한 컬럼 추가
--
-- 이미 데이터가 들어 있는 DB에 적용한다.
-- 새로 만들 때는 schema.sql에 같은 내용이 들어 있으므로 이 파일이 필요 없다.
--
-- 실행: psql "$DATABASE_URL" -f db/migration_v2.sql
--       (또는 Neon 콘솔에 붙여넣기)
--
-- 여러 번 실행해도 안전하도록 IF NOT EXISTS / DROP IF EXISTS 를 쓴다.
-- ============================================================

BEGIN;

-- 기존 사용자는 모두 일반 사용자로 시작한다.
-- 중간에 컬럼만 만들어진 상태에서도 다시 실행하면 DEFAULT·NOT NULL까지 복구한다.
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT;
UPDATE users SET role = 'user' WHERE role IS NULL;
ALTER TABLE users ALTER COLUMN role SET DEFAULT 'user';
ALTER TABLE users ALTER COLUMN role SET NOT NULL;

-- 값을 두 가지로 못 박는다.
-- 'Admin'처럼 대소문자가 틀린 값이 들어가면 requireAdmin이 조용히 통과시키지 않고
-- 계속 403을 내는데, 원인을 찾기 어렵다. DB가 애초에 막는 편이 낫다.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('user', 'admin'));

COMMIT;

-- 관리자 계정은 이 마이그레이션이 만들지 않는다.
-- 회원가입으로도 만들 수 없고, 아래 스크립트로만 지정한다.
--   npm run make-admin -- 아이디
