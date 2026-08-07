-- ============================================================
-- v3 마이그레이션 — 공개 테이스팅 노트
--
-- 이미 데이터가 들어 있는 DB에 적용한다.
-- 새로 만들 때는 schema.sql에 같은 내용이 들어 있으므로 이 파일이 필요 없다.
--
-- 실행: psql "$DATABASE_URL" -f db/migration_v3.sql
--       (또는 Neon 콘솔에 붙여넣기)
--
-- 여러 번 실행해도 안전하도록 IF NOT EXISTS 를 쓴다.
-- ============================================================

BEGIN;

-- 노트의 공개 여부.
--
-- 기본값을 TRUE로 두면 이미 작성된 노트가 전부 공개로 바뀐다.
-- 작성자 동의 없이 공개 범위를 넓히는 셈이라 원래는 FALSE가 안전한 선택이지만,
-- 명세가 TRUE를 지정했고 실사용자가 없는 과제용 DB라 그대로 따른다.
-- 이 판단이 필요했다는 사실 자체가 보고서 항목이다.
--
-- 중간에 컬럼만 추가된 상태에서도 다시 실행하면 DEFAULT·NOT NULL까지 복구한다.
ALTER TABLE notes ADD COLUMN IF NOT EXISTS is_public BOOLEAN;
UPDATE notes SET is_public = TRUE WHERE is_public IS NULL;
ALTER TABLE notes ALTER COLUMN is_public SET DEFAULT TRUE;
ALTER TABLE notes ALTER COLUMN is_public SET NOT NULL;

-- 로트 상세에서 "이 로트의 노트를 최신순으로" 읽는 것이 이 기능의 주 질의다.
-- bean_id로 거르고 created_at으로 정렬하는 일을 인덱스 하나가 함께 처리한다.
-- 정렬 방향까지 인덱스에 담아야 ORDER BY에서 따로 정렬하지 않는다.
CREATE INDEX IF NOT EXISTS idx_notes_bean_created ON notes (bean_id, created_at DESC);

COMMIT;
