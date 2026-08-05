// /api/favorites — 즐겨찾기 담기·빼기·목록. 전 구간 로그인 필요.
// (user_id, bean_id) 복합 기본키라 같은 로트를 두 번 담는 것은 DB가 막는다.
import express from 'express';
import pool from '../db/pool.js';
import { requireAuth } from './auth.js';

const router = express.Router();

// 아래 모든 즐겨찾기 요청은 로그인된 사용자만 처리한다.
router.use(requireAuth);

// 외래키 위반(23503) — 없는 로트를 담으려 한 경우.
function isForeignKeyViolation(err) {
  return err.code === '23503';
}

// 내 즐겨찾기 목록. 카드에 필요한 로트 정보를 JOIN해 함께 내려준다.
router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT
       f.bean_id, f.created_at,
       b.farm, b.farmer, b.country_ko, b.region, b.award, b.rank,
       b.score::float8      AS score,
       b.bid_per_lb::float8 AS bid_per_lb,
       b.has_korean_buyer,
       p.name_ko AS process_name_ko
     FROM favorites f
     JOIN beans b ON b.id = f.bean_id
     JOIN processes p ON p.key = b.process_key
     WHERE f.user_id = $1
     ORDER BY f.created_at DESC, f.bean_id`,
    [req.session.userId]
  );
  res.json(rows);
});

// 즐겨찾기에 담기.
// 이미 담긴 로트면 복합 기본키에 걸리므로 ON CONFLICT DO NOTHING으로 조용히 넘긴다.
// 반환된 행이 있으면 새로 담긴 것, 없으면 이미 있던 것이라 상태 코드를 나눠 답한다.
router.post('/:beanId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `INSERT INTO favorites (user_id, bean_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, bean_id) DO NOTHING
       RETURNING bean_id`,
      [req.session.userId, req.params.beanId]
    );

    const created = rows.length > 0;
    res.status(created ? 201 : 200).json({ bean_id: req.params.beanId, created });
  } catch (err) {
    if (isForeignKeyViolation(err)) {
      return res.status(404).json({ error: '존재하지 않는 로트입니다.' });
    }
    throw err;
  }
});

// 즐겨찾기에서 빼기. 내 즐겨찾기만 지워지도록 user_id를 함께 건다.
// 토글 버튼이 연속으로 눌려도 문제가 없도록, 이미 빠진 상태여도 200으로 답하고
// 실제로 지워졌는지를 removed로 알려준다.
router.delete('/:beanId', async (req, res) => {
  const { rows } = await pool.query(
    'DELETE FROM favorites WHERE user_id = $1 AND bean_id = $2 RETURNING bean_id',
    [req.session.userId, req.params.beanId]
  );

  res.json({ bean_id: req.params.beanId, removed: rows.length > 0 });
});

export default router;
