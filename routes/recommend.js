// /api/recommend — 취향 기반 추천. 전 구간 로그인 필요.
//
// detail.html의 유사 로트가 "로트 ↔ 로트" 거리를 잰다면, 여기서는 "사용자 프로필 ↔ 로트" 거리를 잰다.
// 계산 방식은 같고 기준점만 다르다.
// 거리 계산과 정렬은 SQL이 한다. 74건을 받아 와 JS에서 sort 하지 않는다.
import express from 'express';
import pool from '../db/pool.js';
import { requireAuth } from './auth.js';

const router = express.Router();

router.use(requireAuth);

// 감각 6축. 프로필·거리·경향이 모두 이 순서를 따른다.
const SENSORY_AXES = [
  { key: 'aroma', label: '향' },
  { key: 'acidity', label: '산미' },
  { key: 'body', label: '바디' },
  { key: 'sweetness', label: '단맛' },
  { key: 'aftertaste', label: '후미' },
  { key: 'balance', label: '밸런스' }
];

// 프로필을 만들 때 우선 대상으로 삼는 별점.
const PREFERRED_MIN_RATING = 4;
// 이 수를 못 채우면 전체 노트로 넓힌다.
const MIN_NOTES_FOR_PREFERRED = 3;

// 매칭률 환산 기준. 6축이 모두 있으면 명세의 √96이다.
// 노트 입력은 축별 미기록을 허용하므로, 일부 축만 있으면 실제 계산 축 수에 맞춘다.
// 그러지 않으면 비교하지 않은 축까지 일치한 것처럼 매칭률이 과도하게 높아진다.
const AXIS_MAX_GAP = 4;
const maxDistanceFor = (axisCount) => Math.sqrt(axisCount * AXIS_MAX_GAP * AXIS_MAX_GAP);

const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 12;

// 프로필 없음 응답은 클라이언트가 그대로 표시한다.
// 건수를 못 박지 않는다 — 노트 1건만 있어도 프로필은 생기고,
// 3건은 "별점 4점 이상만 쓸지, 전체로 넓힐지"를 가르는 값일 뿐이다.
// 대신 쌓을수록 평균이 안정된다는 사실을 알려 준다.
const NO_PROFILE_MESSAGE = '노트를 등록하면 추천이 시작됩니다. 노트 수가 늘어날수록 추천 정확도가 올라갑니다';

// 노트는 있는데 감각 6축을 하나도 기록하지 않은 경우. 거리를 잴 기준이 없다.
// 이미 노트를 쓴 사람에게 "노트를 등록하라"고 하면 무엇이 부족한지 알 수 없다.
const NO_AXES_MESSAGE = '노트에 감각 6축을 기록하면 추천이 시작됩니다. 기록이 쌓일수록 추천 정확도가 올라갑니다';
// 프로필에서 값이 실제로 채워진 축만 고른다.
// 기록되지 않은 축을 SQL에 넣으면 POWER(x - NULL, 2)가 NULL이 되어
// 거리 전체가 NULL로 무너지고 정렬이 뜻을 잃는다.
const usableAxesOf = (axes) => SENSORY_AXES.filter((axis) => typeof axes[axis.key] === 'number');

// ============================================================
// 취향 프로필
// ============================================================

// 한 코호트(별점 조건)의 가중 평균을 낸다.
// 분모를 SUM(rating)이 아니라 "그 축을 기록한 노트의 rating 합"으로 잡는다.
// 축을 비워 둔 노트가 있으면 분모가 커져 평균이 실제보다 낮게 나오기 때문이다.
function weightedAverageQuery(userId, minRating) {
  const axisExpressions = SENSORY_AXES.map((axis, index) => `
    (SUM(n.rating * n.${axis.key})
       / NULLIF(SUM(n.rating) FILTER (WHERE n.${axis.key} IS NOT NULL), 0)
    )::float8 AS ${axis.key}`).join(',');

  return pool.query(
    `SELECT
       COUNT(*)::int AS note_count,
       ${axisExpressions}
     FROM notes n
     WHERE n.user_id = $1 AND n.rating >= $2`,
    [userId, minRating]
  );
}

/**
 * 사용자의 취향 프로필을 만든다.
 *
 * 명세의 순서를 그대로 따른다.
 *   1) rating >= 4 인 노트를 대상으로 한다
 *   2) 3건 미만이면 전체 노트로 넓힌다
 *   3) 그래도 1건 미만이면 프로필 없음
 *   4) 6축 각각 가중 평균 — 가중치는 rating
 *
 * @returns {Promise<{ noteCount:number, minRating:number, usedFallback:boolean, axes:object } | null>}
 */
export async function buildTasteProfile(userId) {
  // 1) 별점 4점 이상
  let minRating = PREFERRED_MIN_RATING;
  let { rows } = await weightedAverageQuery(userId, minRating);

  // 2) 표본이 적으면 전체 노트로 넓힌다. rating은 1 이상이라 사실상 조건이 없어진다.
  //    이때 프로필의 성격이 달라지므로(좋아한 커피만 → 마신 커피 전부)
  //    넓혔는지 여부를 응답에 남겨 화면이 근거를 정확히 설명할 수 있게 한다.
  const usedFallback = rows[0].note_count < MIN_NOTES_FOR_PREFERRED;
  if (usedFallback) {
    minRating = 1;
    ({ rows } = await weightedAverageQuery(userId, minRating));
  }

  // 3) 노트가 하나도 없으면 만들 수 없다.
  if (rows[0].note_count < 1) return null;

  // 4) 축만 추려 담는다. 아무도 기록하지 않은 축은 null로 남는다.
  const axes = {};
  for (const axis of SENSORY_AXES) axes[axis.key] = rows[0][axis.key];

  return { noteCount: rows[0].note_count, minRating, usedFallback, axes };
}

// ============================================================
// 경향
// ============================================================

// 값이 있는 축만 모아 큰 순으로 정렬한다. 축이 비어 있으면 비교 대상에서 뺀다.
function rankAxes(axes) {
  return SENSORY_AXES
    .filter((axis) => typeof axes[axis.key] === 'number')
    .sort((a, b) => axes[b.key] - axes[a.key]);
}

/**
 * 선호 가공방식과 가장 높은·낮은 축을 찾는다.
 *
 * 가공방식은 SQL이 GROUP BY로 뽑고, 축 비교는 이미 만들어 둔 프로필에서 읽는다.
 * 프로필을 여기서 다시 계산하면 폴백 규칙을 두 곳에 두게 되고,
 * 화면의 레이더 차트와 경향 문구가 서로 다른 표본을 가리킬 수 있다.
 *
 * @param {number} userId
 * @param {object} profile buildTasteProfile()이 돌려준 프로필
 */
export async function findTendency(userId, profile = null) {
  // 평균 별점이 가장 높은 가공방식. 같으면 노트가 많은 쪽을 택한다.
  const { rows } = await pool.query(
    `SELECT
       p.key,
       p.name_ko                       AS name_ko,
       COUNT(*)::int                   AS count,
       ROUND(AVG(n.rating), 2)::float8 AS avg_rating
     FROM notes n
     JOIN beans b     ON b.id = n.bean_id
     JOIN processes p ON p.key = b.process_key
     WHERE n.user_id = $1
     GROUP BY p.key, p.name_ko
     ORDER BY AVG(n.rating) DESC, COUNT(*) DESC, p.key
     LIMIT 1`,
    [userId]
  );

  // 공개 함수는 명세의 findTendency(userId) 형태로도 독립 호출할 수 있어야 한다.
  // 라우터에서는 이미 계산한 프로필을 넘겨 같은 집계를 반복하지 않는다.
  const resolvedProfile = profile ?? await buildTasteProfile(userId);
  const ranked = rankAxes(resolvedProfile?.axes ?? {});

  return {
    favoriteProcess: rows[0]
      ? {
          key: rows[0].key,
          nameKo: rows[0].name_ko,
          avgRating: rows[0].avg_rating,
          count: rows[0].count
        }
      : null,
    strongestAxis: ranked[0]?.key ?? null,
    weakestAxis: ranked.at(-1)?.key ?? null
  };
}

// ============================================================
// 가까운 로트 찾기
// ============================================================

/**
 * 프로필과 감각 6축 거리가 가까운 로트를 가져온다.
 *
 * 거리 계산·정렬·자르기를 모두 SQL이 한다.
 * 이미 노트를 쓴 로트와 즐겨찾기한 로트는 빼는데, 이미 아는 커피를 추천할 이유가 없어서다.
 * (notes.bean_id와 favorites.bean_id는 NOT NULL이라 NOT IN이 안전하다.
 *  NULL이 섞이면 NOT IN은 아무것도 통과시키지 못한다.)
 */
export async function findNearestBeans(profile, userId, limit) {
  // 기록된 축만 거리에 넣는다. 비어 있는 축을 넣으면 거리가 통째로 NULL이 된다.
  const axes = usableAxesOf(profile.axes);
  if (axes.length === 0) return [];

  const axisValues = axes.map((axis) => profile.axes[axis.key]);
  // 축 개수가 달라지므로 사용자·개수 파라미터 번호도 함께 밀린다.
  const userParam = `$${axes.length + 1}`;
  const limitParam = `$${axes.length + 2}`;

  // 축마다 프로필 값과의 차이도 함께 돌려받는다. 추천 이유를 만들 때 쓴다.
  const diffExpressions = axes
    .map((axis, index) => `ABS(s.${axis.key} - $${index + 1})::float8 AS diff_${axis.key}`)
    .join(',\n       ');

  const distanceExpression = axes
    .map((axis, index) => `POWER(s.${axis.key} - $${index + 1}, 2)`)
    .join(' + ');

  const { rows } = await pool.query(
    `WITH known AS (
       -- 이미 겪어 본 로트
       SELECT bean_id FROM notes     WHERE user_id = ${userParam}
       UNION
       SELECT bean_id FROM favorites WHERE user_id = ${userParam}
     )
     SELECT
       b.id, b.farm, b.farmer, b.country_ko, b.region, b.award, b.rank,
       b.score::float8            AS score,
       b.bid_per_lb::float8       AS bid_per_lb,
       b.total_value_usd::float8  AS total_value_usd,
       b.has_korean_buyer,
       b.process_key,
       p.name_ko                  AS process_name_ko,
       ${diffExpressions},
       SQRT(${distanceExpression})::float8 AS distance
     FROM beans b
     JOIN sensory s   ON s.bean_id = b.id
     JOIN processes p ON p.key = b.process_key
     WHERE b.id NOT IN (SELECT bean_id FROM known)
     ORDER BY distance ASC, b.id ASC
     LIMIT ${limitParam}`,
    [...axisValues, userId, limit]
  );

  return rows;
}

// ============================================================
// 추천 이유·매칭률
// ============================================================

// 받침이 있으면 '과', 없으면 '와'. 조사를 잘못 붙이면 문장이 어색해진다.
function hasFinalConsonant(word) {
  const code = word.charCodeAt(word.length - 1);
  if (code < 0xac00 || code > 0xd7a3) return false;
  return (code - 0xac00) % 28 !== 0;
}

const withWa = (word) => `${word}${hasFinalConsonant(word) ? '과' : '와'}`;
const withI = (word) => `${word}${hasFinalConsonant(word) ? '이' : '가'}`;

// 프로필과 가장 가까운 두 축을 찾아 문장으로 만든다. 별도 테이블 없이 계산으로 낸다.
function buildReason(row) {
  const closest = SENSORY_AXES
    .filter((axis) => typeof row[`diff_${axis.key}`] === 'number')
    .sort((a, b) => row[`diff_${a.key}`] - row[`diff_${b.key}`])
    .slice(0, 2);

  if (closest.length === 0) return '감각 정보가 없어 이유를 설명할 수 없습니다';
  if (closest.length === 1) return `${withI(closest[0].label)} 취향 프로필과 가깝습니다`;

  return `${withWa(closest[0].label)} ${withI(closest[1].label)} 취향 프로필과 가깝습니다`;
}

// 거리를 0~100의 매칭률로 바꾼다. 쓰인 축이 모두 4점씩 벌어진 경우를 0%로 둔다.
function toMatchPercent(distance, maxDistance) {
  const percent = 100 - (distance / maxDistance) * 100;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

// 응답에 내보낼 형태로 다듬는다. 계산에만 쓴 축별 차이는 빼고 보낸다.
function toRecommendation(row, maxDistance) {
  const item = {
    ...row,
    distance: row.distance,
    matchPercent: toMatchPercent(row.distance, maxDistance),
    reason: buildReason(row)
  };
  for (const axis of SENSORY_AXES) delete item[`diff_${axis.key}`];
  return item;
}

// ============================================================
// 라우터
// ============================================================

// 몇 건을 추천할지. 화면은 3건을 쓰지만 호출부가 조정할 수 있게 열어 둔다.
function parseLimit(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(value)));
}

router.get('/', async (req, res) => {
  const userId = req.session.userId;

  const profile = await buildTasteProfile(userId);

  // 노트가 없으면 추천할 근거 자체가 없다. 오류가 아니라 정상 상태다.
  if (!profile) {
    return res.json({ hasProfile: false, message: NO_PROFILE_MESSAGE });
  }

  // 노트는 있지만 감각을 하나도 기록하지 않았다면 거리를 잴 기준이 없다.
  const usableAxes = usableAxesOf(profile.axes);
  if (usableAxes.length === 0) {
    return res.json({ hasProfile: false, message: NO_AXES_MESSAGE });
  }

  const limit = parseLimit(req.query.limit);

  // 경향과 추천 목록은 서로를 기다릴 이유가 없어 동시에 부른다.
  const [tendency, nearest] = await Promise.all([
    findTendency(userId, profile),
    findNearestBeans(profile, userId, limit)
  ]);

  const maxDistance = maxDistanceFor(usableAxes.length);

  res.json({
    hasProfile: true,
    // 근거를 화면이 그대로 설명할 수 있도록, 몇 건을 어떤 기준으로 썼는지 함께 보낸다.
    basis: {
      noteCount: profile.noteCount,
      minRating: profile.minRating,
      usedFallback: profile.usedFallback
    },
    profile: profile.axes,
    tendency,
    items: nearest.map((row) => toRecommendation(row, maxDistance))
  });
});

export default router;
