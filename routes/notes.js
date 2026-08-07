// /api/notes — 내 테이스팅 노트 CRUD. 전 구간 로그인 필요.
// 수정·삭제 쿼리의 WHERE에는 반드시 user_id를 함께 넣는다.
// id만으로 대상을 고르면 남의 노트 id를 넣었을 때 그대로 처리되기 때문이다.
import express from 'express';
import pool from '../db/pool.js';
import { requireAuth } from './auth.js';

const router = express.Router();

// 이 라우터의 모든 경로에 로그인 검사를 건다.
router.use(requireAuth);

// 감각 6축. 노트에도 로트와 같은 축을 기록한다.
const SENSORY_AXES = ['aroma', 'acidity', 'body', 'sweetness', 'aftertaste', 'balance'];

const AXIS_MIN = 0;
const AXIS_MAX = 5;
const COMMENT_MAX = 500;
const BREW_METHOD_MAX = 50;

// notes.id는 SERIAL(INTEGER)이라 여기까지만 존재할 수 있다.
// 이 값을 넘겨도 그대로 DB로 보내면 "out of range for type integer" 오류가 나서
// 잘못된 입력이 서버 오류(500)로 둔갑한다.
const MAX_NOTE_ID = 2_147_483_647;

// 목록·상세 응답에서 공통으로 쓰는 SELECT. NUMERIC은 float8로 캐스팅해 숫자로 내린다.
const NOTE_COLUMNS = `
  n.id, n.bean_id, n.brew_method, n.rating, n.comment,
  n.aroma::float8      AS aroma,
  n.acidity::float8    AS acidity,
  n.body::float8       AS body,
  n.sweetness::float8  AS sweetness,
  n.aftertaste::float8 AS aftertaste,
  n.balance::float8    AS balance,
  n.is_public AS "isPublic",
  n.created_at, n.updated_at,
  b.farm, b.country_ko, b.award, b.rank,
  b.score::float8 AS bean_score,
  p.name_ko       AS process_name_ko`;

const NOTE_FROM = `
  FROM notes n
  JOIN beans b ON b.id = n.bean_id
  JOIN processes p ON p.key = b.process_key`;

// ============================================================
// 입력 검증
// ============================================================

// 감각 축 하나를 확인한다. 값이 없으면 null(미입력)로 취급한다.
function parseAxis(value) {
  if (value === undefined || value === null || value === '') return { value: null };
  if (typeof value !== 'number' && typeof value !== 'string') {
    return { error: `감각 점수는 ${AXIS_MIN}~${AXIS_MAX} 사이의 숫자여야 합니다.` };
  }
  if (typeof value === 'string' && value.trim() === '') {
    return { error: `감각 점수는 ${AXIS_MIN}~${AXIS_MAX} 사이의 숫자여야 합니다.` };
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < AXIS_MIN || parsed > AXIS_MAX) {
    return { error: `감각 점수는 ${AXIS_MIN}~${AXIS_MAX} 사이여야 합니다.` };
  }
  return { value: parsed };
}

// 공개 여부를 확인한다. 불리언만 받는다.
//
// 문자열을 그대로 쓰면 안 된다. Boolean('false')는 true라서,
// 비공개로 두려던 노트가 공개로 뒤집힌다. 그래서 형 변환 없이 타입부터 본다.
// 값이 없으면 '지정 안 함'(null)으로 두고, 무엇을 기본으로 삼을지는 호출부가 정한다.
function parseIsPublic(value) {
  if (value === undefined || value === null) return { value: null };
  if (typeof value !== 'boolean') {
    return { error: '공개 여부는 true 또는 false여야 합니다.' };
  }
  return { value };
}

// 노트 입력값을 확인하고 DB에 넣을 형태로 정리한다.
// 문제가 있으면 { error }를, 없으면 { value }를 돌려준다.
function validateNote(body) {
  const { bean_id: beanId, brew_method: brewMethod, rating, comment } = body ?? {};

  if (typeof beanId !== 'string' || beanId.trim() === '') {
    return { error: '로트를 선택해 주세요.' };
  }

  // 별점은 1~5의 정수만 받는다. 스키마의 CHECK와 같은 범위를 앱에서도 막는다.
  if (typeof rating !== 'number' && typeof rating !== 'string') {
    return { error: '별점은 1~5 사이의 정수여야 합니다.' };
  }
  if (typeof rating === 'string' && rating.trim() === '') {
    return { error: '별점은 1~5 사이의 정수여야 합니다.' };
  }
  const ratingNumber = Number(rating);
  if (!Number.isInteger(ratingNumber) || ratingNumber < 1 || ratingNumber > 5) {
    return { error: '별점은 1~5 사이의 정수여야 합니다.' };
  }

  if (comment !== undefined && comment !== null && typeof comment !== 'string') {
    return { error: '코멘트 형식이 올바르지 않습니다.' };
  }
  // 저장할 값을 먼저 다듬고 그 길이를 센다.
  // 다듬기 전 값으로 세면 앞뒤 공백까지 글자 수에 포함돼, 실제로는 500자인 글이 거부된다.
  const trimmedComment = typeof comment === 'string' ? comment.trim() : null;
  // 이모지처럼 두 칸을 차지하는 문자를 한 글자로 세기 위해 코드포인트 기준으로 센다.
  if (trimmedComment !== null && [...trimmedComment].length > COMMENT_MAX) {
    return { error: `코멘트는 ${COMMENT_MAX}자 이하로 입력해 주세요.` };
  }

  if (brewMethod !== undefined && brewMethod !== null && typeof brewMethod !== 'string') {
    return { error: '추출 방식 형식이 올바르지 않습니다.' };
  }
  if (typeof brewMethod === 'string' && brewMethod.trim().length > BREW_METHOD_MAX) {
    return { error: `추출 방식은 ${BREW_METHOD_MAX}자 이하로 입력해 주세요.` };
  }

  const axes = {};
  for (const axis of SENSORY_AXES) {
    const parsed = parseAxis(body[axis]);
    if (parsed.error) return { error: parsed.error };
    axes[axis] = parsed.value;
  }

  const isPublic = parseIsPublic((body ?? {}).isPublic);
  if (isPublic.error) return { error: isPublic.error };

  return {
    value: {
      beanId: beanId.trim(),
      brewMethod: typeof brewMethod === 'string' && brewMethod.trim() !== '' ? brewMethod.trim() : null,
      rating: ratingNumber,
      comment: trimmedComment === '' ? null : trimmedComment,
      axes,
      // null이면 '지정 안 함'이다. 작성은 공개를 기본으로, 수정은 원래 값을 지킨다.
      isPublic: isPublic.value
    }
  };
}

// 경로의 :id를 노트 번호로 바꾼다. 컬럼이 담을 수 있는 범위 밖이면 null을 돌려준다.
function parseNoteId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1 || id > MAX_NOTE_ID) return null;
  return id;
}

// 존재하지 않는 로트를 지정하면 외래키 위반(23503)이 난다.
// 500으로 흘리지 않고 사용자 잘못임을 알려준다.
function isForeignKeyViolation(err) {
  return err.code === '23503';
}

// ============================================================
// 라우터
// ============================================================

// 내 노트 목록. 로트 정보를 JOIN해 카드에 필요한 값까지 함께 내려준다.
// 인덱스 notes(user_id, created_at DESC)가 이 쿼리를 그대로 받는다.
router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ${NOTE_COLUMNS} ${NOTE_FROM}
     WHERE n.user_id = $1
     ORDER BY n.created_at DESC, n.id DESC`,
    [req.session.userId]
  );
  res.json(rows);
});

// 노트 작성.
router.post('/', async (req, res) => {
  const { error, value } = validateNote(req.body);
  if (error) return res.status(400).json({ error });

  const { beanId, brewMethod, rating, comment, axes, isPublic } = value;

  try {
    // 방금 넣은 행의 id를 받아 같은 조건으로 다시 조회해 로트 정보까지 붙여 돌려준다.
    const { rows } = await pool.query(
      `WITH inserted AS (
         INSERT INTO notes (
           user_id, bean_id, brew_method, rating, comment,
           aroma, acidity, body, sweetness, aftertaste, balance, is_public
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *
       )
       SELECT ${NOTE_COLUMNS}
       FROM inserted n
       JOIN beans b ON b.id = n.bean_id
       JOIN processes p ON p.key = b.process_key`,
      [
        req.session.userId, beanId, brewMethod, rating, comment,
        axes.aroma, axes.acidity, axes.body, axes.sweetness, axes.aftertaste, axes.balance,
        // 보내지 않았으면 공개로 만든다. 컬럼 기본값과 같은 값을 앱에서도 분명히 한다.
        isPublic ?? true
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (isForeignKeyViolation(err)) {
      return res.status(400).json({ error: '존재하지 않는 로트입니다.' });
    }
    throw err;
  }
});

// 노트 수정. WHERE에 user_id가 함께 들어가므로 남의 노트 id를 넣어도 대상이 잡히지 않는다.
// 그 경우 갱신된 행이 0건이 되어 404로 답한다. 남의 노트가 있는지 없는지도 알려주지 않는다.
router.put('/:id', async (req, res) => {
  const noteId = parseNoteId(req.params.id);
  if (noteId === null) {
    return res.status(400).json({ error: '잘못된 노트 번호입니다.' });
  }

  const { error, value } = validateNote(req.body);
  if (error) return res.status(400).json({ error });

  const { beanId, brewMethod, rating, comment, axes, isPublic } = value;

  try {
    const { rows } = await pool.query(
      `WITH updated AS (
         UPDATE notes SET
           bean_id = $3, brew_method = $4, rating = $5, comment = $6,
           aroma = $7, acidity = $8, body = $9,
           sweetness = $10, aftertaste = $11, balance = $12,
           is_public = COALESCE($13, is_public),
           updated_at = now()
         WHERE id = $1 AND user_id = $2
         RETURNING *
       )
       SELECT ${NOTE_COLUMNS}
       FROM updated n
       JOIN beans b ON b.id = n.bean_id
       JOIN processes p ON p.key = b.process_key`,
      [
        noteId, req.session.userId, beanId, brewMethod, rating, comment,
        axes.aroma, axes.acidity, axes.body, axes.sweetness, axes.aftertaste, axes.balance,
        // 보내지 않았으면 COALESCE가 원래 값을 지킨다.
        // 여기서 true를 기본으로 삼으면, 필드를 빠뜨린 요청이 비공개 노트를 공개로 바꿔 버린다.
        isPublic
      ]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: '노트를 찾을 수 없습니다.' });
    }
    res.json(rows[0]);
  } catch (err) {
    if (isForeignKeyViolation(err)) {
      return res.status(400).json({ error: '존재하지 않는 로트입니다.' });
    }
    throw err;
  }
});

// 노트 삭제. 수정과 마찬가지로 user_id를 함께 걸어 내 노트만 지워지게 한다.
router.delete('/:id', async (req, res) => {
  const noteId = parseNoteId(req.params.id);
  if (noteId === null) {
    return res.status(400).json({ error: '잘못된 노트 번호입니다.' });
  }

  const { rows } = await pool.query(
    'DELETE FROM notes WHERE id = $1 AND user_id = $2 RETURNING id',
    [noteId, req.session.userId]
  );

  if (rows.length === 0) {
    return res.status(404).json({ error: '노트를 찾을 수 없습니다.' });
  }
  res.json({ deleted: rows[0].id });
});

export default router;
