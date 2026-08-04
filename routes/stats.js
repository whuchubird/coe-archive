// /api/stats — 통계 페이지가 쓰는 집계 엔드포인트 7종.
// 집계는 전부 SQL의 GROUP BY·AVG·COUNT로 끝낸다.
// 74행을 통째로 내려보내 JS에서 reduce로 돌리면 서버에서 처리할 이유가 없어지고,
// 데이터가 늘었을 때 그대로 무너진다.
import express from 'express';
import pool from '../db/pool.js';
import { requireAuth } from './auth.js';

const router = express.Router();

// 품종 랭킹에서 보여줄 개수.
const VARIETY_LIMIT = 10;
// 내 취향 요약에서 뽑을 향미 키워드 개수.
const MY_FLAVOR_LIMIT = 5;

// 전체 요약. 카운트·평균·최고값을 한 번의 스캔으로 모두 구한다.
// FILTER 절을 쓰면 등급별·한국 낙찰 건수까지 같은 쿼리에서 나온다.
router.get('/overview', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*)::int                                  AS total_beans,
      COUNT(*) FILTER (WHERE award = 'COE')::int     AS coe_count,
      COUNT(*) FILTER (WHERE award = 'NW')::int      AS nw_count,
      COUNT(*) FILTER (WHERE has_korean_buyer)::int  AS korean_count,
      COUNT(DISTINCT country)::int                   AS country_count,
      ROUND(AVG(score), 2)::float8                   AS avg_score,
      MIN(score)::float8                             AS min_score,
      MAX(score)::float8                             AS max_score,
      ROUND(AVG(bid_per_lb), 2)::float8              AS avg_bid_per_lb,
      MIN(bid_per_lb)::float8                        AS min_bid_per_lb,
      MAX(bid_per_lb)::float8                        AS max_bid_per_lb,
      ROUND(SUM(total_value_usd), 2)::float8         AS total_value_usd
    FROM beans
  `);
  res.json(rows[0]);
});

// 가공방식별 집계. 도넛 차트와 비교표가 쓴다.
// processes에서 LEFT JOIN으로 시작해야 로트가 하나도 없는 가공방식도 0건으로 나온다.
router.get('/by-process', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      p.key,
      p.name_ko,
      p.name_en,
      COUNT(b.id)::int                    AS count,
      ROUND(AVG(b.score), 2)::float8      AS avg_score,
      ROUND(AVG(b.bid_per_lb), 2)::float8 AS avg_bid_per_lb,
      MAX(b.bid_per_lb)::float8           AS max_bid_per_lb
    FROM processes p
    LEFT JOIN beans b ON b.process_key = p.key
    GROUP BY p.key, p.name_ko, p.name_en
    ORDER BY COUNT(b.id) DESC, p.key
  `);
  res.json(rows);
});

// 국가별 집계. 평균 점수 막대 그래프가 쓴다.
router.get('/by-country', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      country,
      country_ko,
      COUNT(*)::int                                 AS count,
      COUNT(*) FILTER (WHERE award = 'COE')::int    AS coe_count,
      COUNT(*) FILTER (WHERE has_korean_buyer)::int AS korean_count,
      ROUND(AVG(score), 2)::float8                  AS avg_score,
      MAX(score)::float8                            AS max_score,
      ROUND(AVG(bid_per_lb), 2)::float8             AS avg_bid_per_lb,
      MAX(bid_per_lb)::float8                       AS max_bid_per_lb
    FROM beans
    GROUP BY country, country_ko
    ORDER BY COUNT(*) DESC, country
  `);
  res.json(rows);
});

// 산점도용 좌표. 점 하나를 그리는 데 필요한 값만 담아 가볍게 내려보낸다.
// 두 축 중 하나라도 비면 점을 찍을 수 없으므로 낙찰가가 없는 로트는 제외한다.
router.get('/scatter', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      b.id,
      b.farm,
      b.score::float8      AS score,
      b.bid_per_lb::float8 AS bid_per_lb,
      b.process_key
    FROM beans b
    WHERE b.bid_per_lb IS NOT NULL
    ORDER BY b.score DESC, b.id
  `);
  res.json(rows);
});

// 품종 랭킹. bean_varieties를 거쳐 로트 수를 세고 많은 순으로 자른다.
// 한 로트에 품종이 여러 개 붙을 수 있어 합계는 74를 넘는다.
router.get('/varieties', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT
       v.name,
       COUNT(*)::int                       AS count,
       ROUND(AVG(b.score), 2)::float8      AS avg_score,
       ROUND(AVG(b.bid_per_lb), 2)::float8 AS avg_bid_per_lb,
       MAX(b.score)::float8                AS max_score
     FROM bean_varieties bv
     JOIN varieties v ON v.id = bv.variety_id
     JOIN beans b     ON b.id = bv.bean_id
     GROUP BY v.name
     ORDER BY COUNT(*) DESC, v.name
     LIMIT $1`,
    [VARIETY_LIMIT]
  );
  res.json(rows);
});

// 한국 업체가 낙찰한 로트. 업체 목록을 서브쿼리로 묶어 한 번에 내려준다.
// is_korean 업체만 따로 뽑아 화면에서 강조할 수 있게 한다.
router.get('/korean', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      b.id, b.farm, b.farmer, b.country_ko, b.region, b.award, b.rank,
      b.score::float8           AS score,
      b.bid_per_lb::float8      AS bid_per_lb,
      b.weight_lb::float8       AS weight_lb,
      b.total_value_usd::float8 AS total_value_usd,
      p.name_ko                 AS process_name_ko,
      COALESCE((
        SELECT json_agg(bu.name ORDER BY bu.name)
        FROM bean_buyers bb
        JOIN buyers bu ON bu.id = bb.buyer_id
        WHERE bb.bean_id = b.id
      ), '[]'::json) AS buyers,
      COALESCE((
        SELECT json_agg(bu.name ORDER BY bu.name)
        FROM bean_buyers bb
        JOIN buyers bu ON bu.id = bb.buyer_id
        WHERE bb.bean_id = b.id AND bu.is_korean
      ), '[]'::json) AS korean_buyers
    FROM beans b
    JOIN processes p ON p.key = b.process_key
    WHERE b.has_korean_buyer
    ORDER BY b.bid_per_lb DESC NULLS LAST, b.id
  `);
  res.json(rows);
});

// ============================================================
// 내 취향 요약 (로그인 필요)
// ============================================================

// 노트 전체를 한 줄로 요약한다. 노트가 없으면 COUNT는 0, AVG는 null이 된다.
function selectMySummary(userId) {
  return pool.query(
    `SELECT
       COUNT(*)::int                    AS note_count,
       COUNT(DISTINCT n.bean_id)::int   AS bean_count,
       ROUND(AVG(n.rating), 2)::float8  AS avg_rating,
       ROUND(AVG(n.aroma), 2)::float8      AS avg_aroma,
       ROUND(AVG(n.acidity), 2)::float8    AS avg_acidity,
       ROUND(AVG(n.body), 2)::float8       AS avg_body,
       ROUND(AVG(n.sweetness), 2)::float8  AS avg_sweetness,
       ROUND(AVG(n.aftertaste), 2)::float8 AS avg_aftertaste,
       ROUND(AVG(n.balance), 2)::float8    AS avg_balance,
       ROUND(AVG(b.score), 2)::float8      AS avg_bean_score
     FROM notes n
     JOIN beans b ON b.id = n.bean_id
     WHERE n.user_id = $1`,
    [userId]
  );
}

// 가공방식별로 묶어 평균 별점과 감각 평균을 낸다. 어떤 방식에 후한 점수를 주는지 드러난다.
function selectMyByProcess(userId) {
  return pool.query(
    `SELECT
       p.key                            AS process_key,
       p.name_ko,
       COUNT(*)::int                    AS note_count,
       ROUND(AVG(n.rating), 2)::float8  AS avg_rating,
       ROUND(AVG(n.acidity), 2)::float8   AS avg_acidity,
       ROUND(AVG(n.body), 2)::float8      AS avg_body,
       ROUND(AVG(n.sweetness), 2)::float8 AS avg_sweetness,
       ROUND(AVG(b.score), 2)::float8     AS avg_bean_score
     FROM notes n
     JOIN beans b     ON b.id = n.bean_id
     JOIN processes p ON p.key = b.process_key
     WHERE n.user_id = $1
     GROUP BY p.key, p.name_ko
     ORDER BY COUNT(*) DESC, AVG(n.rating) DESC NULLS LAST, p.key`,
    [userId]
  );
}

// 가장 후한 점수를 준 가공방식 하나. 고르는 것도 SQL에서 끝낸다.
// 평균 별점이 같으면 노트가 많은 쪽을 택한다.
function selectMyFavoriteProcess(userId) {
  return pool.query(
    `SELECT
       p.key                           AS process_key,
       p.name_ko,
       COUNT(*)::int                   AS note_count,
       ROUND(AVG(n.rating), 2)::float8 AS avg_rating
     FROM notes n
     JOIN beans b     ON b.id = n.bean_id
     JOIN processes p ON p.key = b.process_key
     WHERE n.user_id = $1
     GROUP BY p.key, p.name_ko
     ORDER BY AVG(n.rating) DESC NULLS LAST, COUNT(*) DESC, p.key
     LIMIT 1`,
    [userId]
  );
}

// 내가 기록한 로트들에 붙은 향미 키워드 순위.
// 같은 로트에 노트를 여러 번 쓰면 그만큼 더 세어져, 자주 찾는 향미가 위로 올라온다.
function selectMyFlavors(userId, limit) {
  return pool.query(
    `SELECT f.name, COUNT(*)::int AS count
     FROM notes n
     JOIN bean_flavors bf ON bf.bean_id = n.bean_id
     JOIN flavor_notes f  ON f.id = bf.flavor_id
     WHERE n.user_id = $1
     GROUP BY f.name
     ORDER BY COUNT(*) DESC, f.name
     LIMIT $2`,
    [userId, limit]
  );
}

// 내 노트 기반 취향 요약. 네 쿼리는 서로를 기다릴 이유가 없어 동시에 보낸다.
router.get('/my', requireAuth, async (req, res) => {
  const userId = req.session.userId;

  const [summary, byProcess, favorite, flavors] = await Promise.all([
    selectMySummary(userId),
    selectMyByProcess(userId),
    selectMyFavoriteProcess(userId),
    selectMyFlavors(userId, MY_FLAVOR_LIMIT)
  ]);

  res.json({
    summary: summary.rows[0],
    by_process: byProcess.rows,
    // 노트가 하나도 없으면 고를 대상이 없으므로 null이 된다.
    favorite_process: favorite.rows[0] ?? null,
    top_flavors: flavors.rows
  });
});

export default router;
