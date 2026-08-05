// SVG 차트를 JS로 직접 만든다. 차트 라이브러리를 쓰지 않는다.
// 그릴 게 레이더·도넛·산점도 세 종류뿐이고, 좌표 계산이 곧 설명할 내용이기 때문이다.
//
// 지금은 레이더만 있다. 도넛·산점도는 통계 페이지를 만들 때 여기에 더한다.

// SVG 요소는 createElement로 만들면 안 된다. 네임스페이스가 달라 화면에 나오지 않는다.
const SVG_NS = 'http://www.w3.org/2000/svg';

// SVG 요소를 만든다. createElement로 만들면 네임스페이스가 달라 화면에 나오지 않는다.
function svgEl(tag, attrs = {}) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined && value !== null) element.setAttribute(key, String(value));
  }
  return element;
}

// ============================================================
// 좌표 계산
// ============================================================

// i번째 축이 향하는 각도(라디안).
// 12시 방향에서 시작해 시계 방향으로 (360/축수)도씩 돈다.
// SVG는 y가 아래로 증가하므로 12시가 -90도(-π/2)다.
function axisAngle(index, axisCount) {
  return -Math.PI / 2 + (index * 2 * Math.PI) / axisCount;
}

// 중심 (cx, cy)에서 거리 radius, 각도 angle만큼 떨어진 점.
// 여기가 삼각함수를 쓰는 유일한 곳이고, 격자·축·데이터 도형이 전부 이 함수를 통해 나온다.
function pointAt(cx, cy, radius, angle) {
  return {
    x: cx + radius * Math.cos(angle),
    y: cy + radius * Math.sin(angle)
  };
}

// polygon의 points 속성에 넣을 "x,y x,y ..." 문자열을 만든다.
// radiusOf(i)가 축마다 다른 거리를 돌려주면 데이터 도형이 되고,
// 모든 축에 같은 값을 돌려주면 정육각형 격자가 된다.
function polygonPoints(cx, cy, axisCount, radiusOf) {
  const parts = [];
  for (let i = 0; i < axisCount; i += 1) {
    const { x, y } = pointAt(cx, cy, radiusOf(i), axisAngle(i, axisCount));
    parts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return parts.join(' ');
}

// ============================================================
// 레이더 차트
// ============================================================

// 감각 6축의 표시 순서와 이름. 커핑 점수표에서 쓰는 순서를 따른다.
export const SENSORY_AXES = [
  { key: 'aroma', label: '향' },
  { key: 'acidity', label: '산미' },
  { key: 'body', label: '바디' },
  { key: 'sweetness', label: '단맛' },
  { key: 'aftertaste', label: '후미' },
  { key: 'balance', label: '밸런스' }
];

// 레이블이 도형에서 얼마나 떨어질지. 글자가 격자에 붙지 않게 띄운다.
const LABEL_GAP = 22;

// 축 끝의 레이블을 어느 쪽으로 정렬할지 정한다.
// 오른쪽 축은 왼쪽 정렬, 왼쪽 축은 오른쪽 정렬, 12시·6시는 가운데 정렬해야 글자가 겹치지 않는다.
function anchorFor(x, cx) {
  if (Math.abs(x - cx) < 1) return 'middle';
  return x > cx ? 'start' : 'end';
}

/**
 * 감각 6축 레이더 차트를 그려 container에 넣는다.
 *
 * @param {Element} container            차트를 담을 요소. 기존 내용은 지운다.
 * @param {object|null} sensory          { aroma, acidity, body, sweetness, aftertaste, balance }
 * @param {object} [options]
 * @param {number} [options.max=5]       축의 최대값
 * @param {number} [options.levels=5]    배경 격자 단계 수
 * @param {number} [options.size=260]    viewBox 한 변의 길이
 * @param {string} [options.title]       스크린리더용 설명
 * @returns {SVGElement|null}            그린 svg 요소. 값이 없으면 null
 */
export function renderRadar(container, sensory, options = {}) {
  const { max = 5, levels = 5, size = 260, title = '감각 6축 프로필' } = options;

  container.replaceChildren();

  if (!sensory) {
    const message = document.createElement('p');
    message.className = 'state';
    message.textContent = '감각 정보가 없습니다.';
    container.append(message);
    return null;
  }

  const axes = SENSORY_AXES;
  const axisCount = axes.length;

  // viewBox 안에서만 계산한다. 실제 화면 크기는 CSS가 정하므로 반응형이 저절로 된다.
  const cx = size / 2;
  const cy = size / 2;
  // 바깥에 레이블이 들어갈 자리를 남긴다.
  const radius = size / 2 - LABEL_GAP - 14;

  const svg = svgEl('svg', {
    viewBox: `0 0 ${size} ${size}`,
    class: 'radar',
    role: 'img'
  });

  // 값이 없는 축은 0으로 둔다. 도형은 그려지되 그 방향으로 찌그러져 보인다.
  const valueOf = (index) => {
    const raw = sensory[axes[index].key];
    const number = Number(raw);
    return Number.isFinite(number) ? Math.min(Math.max(number, 0), max) : 0;
  };

  // 스크린리더는 도형을 읽지 못하므로 값을 글로 남긴다.
  const summary = axes.map((axis, i) => `${axis.label} ${valueOf(i)}`).join(', ');
  const titleEl = svgEl('title');
  titleEl.textContent = `${title} — ${summary}`;
  svg.append(titleEl);

  // ── 배경 격자 : 중심에서 바깥으로 levels 단계 ──────────────
  const grid = svgEl('g', { class: 'radar__grid-group' });
  for (let level = 1; level <= levels; level += 1) {
    const levelRadius = (radius * level) / levels;
    grid.append(svgEl('polygon', {
      class: 'radar__grid',
      points: polygonPoints(cx, cy, axisCount, () => levelRadius)
    }));
  }
  svg.append(grid);

  // ── 축 선 : 중심에서 각 꼭짓점까지 ────────────────────────
  const axisGroup = svgEl('g', { class: 'radar__axis-group' });
  for (let i = 0; i < axisCount; i += 1) {
    const end = pointAt(cx, cy, radius, axisAngle(i, axisCount));
    axisGroup.append(svgEl('line', {
      class: 'radar__axis',
      x1: cx, y1: cy,
      x2: end.x.toFixed(2), y2: end.y.toFixed(2)
    }));
  }
  svg.append(axisGroup);

  // ── 데이터 도형 : 축마다 값에 비례한 거리 ─────────────────
  svg.append(svgEl('polygon', {
    class: 'radar__shape',
    points: polygonPoints(cx, cy, axisCount, (i) => (radius * valueOf(i)) / max)
  }));

  // ── 꼭짓점 점 ─────────────────────────────────────────────
  const dots = svgEl('g', { class: 'radar__dot-group' });
  for (let i = 0; i < axisCount; i += 1) {
    const point = pointAt(cx, cy, (radius * valueOf(i)) / max, axisAngle(i, axisCount));
    dots.append(svgEl('circle', {
      class: 'radar__dot',
      cx: point.x.toFixed(2),
      cy: point.y.toFixed(2),
      r: 3.5
    }));
  }
  svg.append(dots);

  // ── 축 레이블과 값 ────────────────────────────────────────
  const labels = svgEl('g', { class: 'radar__label-group' });
  for (let i = 0; i < axisCount; i += 1) {
    const angle = axisAngle(i, axisCount);
    const at = pointAt(cx, cy, radius + LABEL_GAP, angle);
    const anchor = anchorFor(at.x, cx);

    const label = svgEl('text', {
      class: 'radar__label',
      x: at.x.toFixed(2),
      y: at.y.toFixed(2),
      'text-anchor': anchor
    });
    label.textContent = axes[i].label;

    // 값은 레이블 바로 아래 한 줄로. 숫자는 모노스페이스로 자릿수를 맞춘다.
    const value = svgEl('text', {
      class: 'radar__value',
      x: at.x.toFixed(2),
      y: (at.y + 13).toFixed(2),
      'text-anchor': anchor
    });
    value.textContent = valueOf(i).toFixed(1);

    labels.append(label, value);
  }
  svg.append(labels);

  container.append(svg);
  return svg;
}

// ============================================================
// 계열색과 마커 모양
// ============================================================

// 가공방식 → 색 슬롯. key에 고정이라 필터로 개수가 줄어도 남은 항목 색이 바뀌지 않는다.
const SERIES_SLOT = {
  washed: 1,
  honey: 2,
  'pulped-natural': 3,
  natural: 4,
  experimental: 5
};

// 색만으로 구분하지 않는다. 다크 모드에서 일부 조합의 색각 분리가 경계선이라
// 모양을 함께 써서 색을 못 구분해도 읽히게 한다.
const SERIES_SHAPE = {
  washed: 'circle',
  honey: 'square',
  'pulped-natural': 'triangle',
  natural: 'diamond',
  experimental: 'cross'
};

// 가공방식에 배정된 색 토큰을 돌려준다. 색값은 CSS가 들고 있어 다크 모드가 저절로 따라온다.
export function seriesColor(key) {
  return `var(--series-${SERIES_SLOT[key] ?? 1})`;
}

// 가공방식에 배정된 마커 모양. 색을 구분하지 못해도 모양으로 읽히게 하려는 것이다.
export function seriesShape(key) {
  return SERIES_SHAPE[key] ?? 'circle';
}

// 지정한 모양의 마커를 한 점에 그린다. size는 한 변(또는 지름)에 해당한다.
function markerAt(shape, x, y, size, attrs) {
  const r = size / 2;
  if (shape === 'square') {
    return svgEl('rect', { x: x - r, y: y - r, width: size, height: size, ...attrs });
  }
  if (shape === 'triangle') {
    return svgEl('polygon', { points: `${x},${y - r} ${x + r},${y + r} ${x - r},${y + r}`, ...attrs });
  }
  if (shape === 'diamond') {
    return svgEl('polygon', { points: `${x},${y - r} ${x + r},${y} ${x},${y + r} ${x - r},${y}`, ...attrs });
  }
  if (shape === 'cross') {
    const t = r / 2.4;
    return svgEl('polygon', {
      points: [
        `${x - t},${y - r}`, `${x + t},${y - r}`, `${x + t},${y - t}`, `${x + r},${y - t}`,
        `${x + r},${y + t}`, `${x + t},${y + t}`, `${x + t},${y + r}`, `${x - t},${y + r}`,
        `${x - t},${y + t}`, `${x - r},${y + t}`, `${x - r},${y - t}`, `${x - t},${y - t}`
      ].join(' '),
      ...attrs
    });
  }
  return svgEl('circle', { cx: x, cy: y, r, ...attrs });
}

// 범례. 계열이 둘 이상이면 항상 붙인다 — 색만으로 정체를 알게 두지 않는다.
function renderLegend(items) {
  const list = createList('ul', 'chart-legend');
  for (const item of items) {
    const swatch = svgEl('svg', { class: 'chart-legend__mark', viewBox: '0 0 14 14', 'aria-hidden': 'true' });
    swatch.append(markerAt(item.shape ?? 'circle', 7, 7, 11, { fill: item.color }));

    const li = document.createElement('li');
    li.className = 'chart-legend__item';
    const label = document.createElement('span');
    label.textContent = item.label;
    li.append(swatch, label);
    if (item.note !== undefined) {
      const note = document.createElement('span');
      note.className = 'chart-legend__note num';
      note.textContent = item.note;
      li.append(note);
    }
    list.append(li);
  }
  return list;
}

// 목록 요소를 만든다. 스크린리더가 항목 수를 세도록 role=list를 붙인다.
function createList(tag, className) {
  const list = document.createElement(tag);
  list.className = className;
  list.setAttribute('role', 'list');
  return list;
}

// ============================================================
// 도넛 — 가공방식별 비중
// ============================================================

// 각도를 원 위의 좌표로. 12시에서 시작해 시계 방향으로 돈다.
function arcPoint(cx, cy, radius, fraction) {
  const angle = -Math.PI / 2 + fraction * 2 * Math.PI;
  return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
}

// 바깥 반지름과 안쪽 반지름 사이의 고리 한 조각을 path로 그린다.
function ringSlice(cx, cy, outer, inner, from, to) {
  const o1 = arcPoint(cx, cy, outer, from);
  const o2 = arcPoint(cx, cy, outer, to);
  const i2 = arcPoint(cx, cy, inner, to);
  const i1 = arcPoint(cx, cy, inner, from);
  // 반 바퀴를 넘으면 SVG에 큰 호(large-arc)임을 알려야 한다.
  const large = to - from > 0.5 ? 1 : 0;
  return [
    `M ${o1.x.toFixed(2)} ${o1.y.toFixed(2)}`,
    `A ${outer} ${outer} 0 ${large} 1 ${o2.x.toFixed(2)} ${o2.y.toFixed(2)}`,
    `L ${i2.x.toFixed(2)} ${i2.y.toFixed(2)}`,
    `A ${inner} ${inner} 0 ${large} 0 ${i1.x.toFixed(2)} ${i1.y.toFixed(2)}`,
    'Z'
  ].join(' ');
}

/**
 * 도넛 차트. 합계 대비 비중을 보여준다.
 * @param {Element} container
 * @param {Array<{key:string,label:string,value:number}>} segments
 * @param {object} [options] centerLabel, size
 */
export function renderDonut(container, segments, options = {}) {
  const { size = 220, centerLabel = '' } = options;
  container.replaceChildren();

  const total = segments.reduce((sum, s) => sum + s.value, 0);
  if (total === 0) {
    container.append(createEmptyNote('표시할 값이 없습니다.'));
    return null;
  }

  const cx = size / 2;
  const cy = size / 2;
  const outer = size / 2 - 4;
  const inner = outer * 0.62;

  const svg = svgEl('svg', { viewBox: `0 0 ${size} ${size}`, class: 'donut', role: 'img' });
  const title = svgEl('title');
  title.textContent = segments.map((s) => `${s.label} ${s.value}`).join(', ');
  svg.append(title);

  // 조각 사이를 살짝 띄운다. 붙어 있으면 경계가 색 대비로만 읽힌다.
  const gap = 0.004;
  let cursor = 0;
  for (const segment of segments) {
    const share = segment.value / total;
    const from = cursor + gap / 2;
    const to = cursor + share - gap / 2;
    if (to > from) {
      svg.append(svgEl('path', {
        class: 'donut__slice',
        d: ringSlice(cx, cy, outer, inner, from, to),
        fill: seriesColor(segment.key)
      }));
    }
    cursor += share;
  }

  if (centerLabel !== '') {
    const label = svgEl('text', {
      class: 'donut__center', x: cx, y: cy, 'text-anchor': 'middle', 'dominant-baseline': 'central'
    });
    label.textContent = centerLabel;
    svg.append(label);
  }

  container.append(svg);
  container.append(renderLegend(segments.map((s) => ({
    label: s.label,
    color: seriesColor(s.key),
    shape: seriesShape(s.key),
    note: `${s.value}건 · ${Math.round((s.value / total) * 100)}%`
  }))));

  return svg;
}

// ============================================================
// 막대 — 국가별 평균 점수
// ============================================================

/**
 * 가로 막대. 값이 몇 개 안 되고 이름이 길어 가로로 눕힌다.
 * @param {Array<{label:string,value:number,note?:string}>} items
 * @param {object} [options] min, max, unit
 */
export function renderBar(container, items, options = {}) {
  container.replaceChildren();
  if (items.length === 0) {
    container.append(createEmptyNote('표시할 값이 없습니다.'));
    return null;
  }

  const values = items.map((i) => i.value);
  // 점수처럼 0에서 시작하면 차이가 안 보이는 값은 min을 넘겨 받는다.
  const min = options.min ?? 0;
  const max = options.max ?? Math.max(...values);
  const span = max - min || 1;

  const list = createList('ul', 'bar-chart');
  for (const item of items) {
    const ratio = Math.min(1, Math.max(0, (item.value - min) / span));

    const track = document.createElement('div');
    track.className = 'bar-chart__track';
    const fill = document.createElement('div');
    fill.className = 'bar-chart__fill';
    fill.style.width = `${(ratio * 100).toFixed(1)}%`;
    track.append(fill);

    const row = document.createElement('li');
    row.className = 'bar-chart__row';

    const name = document.createElement('span');
    name.className = 'bar-chart__label';
    name.textContent = item.label;

    const value = document.createElement('span');
    value.className = 'bar-chart__value num';
    value.textContent = item.note ?? String(item.value);

    row.append(name, track, value);
    list.append(row);
  }

  // 0이 아닌 값에서 시작했다면 그 사실을 밝힌다. 막대 길이가 값에 비례하지 않기 때문이다.
  if (min !== 0) {
    const note = document.createElement('p');
    note.className = 'muted chart-note';
    note.textContent = `막대는 ${min}${options.unit ?? ''}부터 그렸습니다. 길이가 값에 그대로 비례하지 않습니다.`;
    container.append(list, note);
  } else {
    container.append(list);
  }

  return list;
}

// ============================================================
// 산점도 — 점수 대 낙찰가
// ============================================================

// 낙찰가는 $4에서 $143까지 벌어져 있어 그냥 그리면 아래쪽에 뭉친다.
// 로그로 눕히면 관계가 훨씬 곧게 보인다(상관계수도 0.69 → 0.78로 올라간다).
const log10 = (v) => Math.log(v) / Math.LN10;

/**
 * 산점도.
 * @param {Array} points  { id, farm, score, bid_per_lb, process_key }
 * @param {object} [options] processLabels(Map), onSelect(id), xMin, xMax
 */
export function renderScatter(container, points, options = {}) {
  const { processLabels = new Map(), onSelect } = options;
  container.replaceChildren();

  const usable = points.filter((p) => Number.isFinite(p.score) && p.bid_per_lb > 0);
  if (usable.length === 0) {
    container.append(createEmptyNote('표시할 점이 없습니다.'));
    return null;
  }

  const width = 720;
  const height = 420;
  const pad = { top: 16, right: 16, bottom: 44, left: 56 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const xMin = options.xMin ?? Math.floor(Math.min(...usable.map((p) => p.score)));
  const xMax = options.xMax ?? Math.ceil(Math.max(...usable.map((p) => p.score)));
  const yMin = Math.min(...usable.map((p) => p.bid_per_lb));
  const yMax = Math.max(...usable.map((p) => p.bid_per_lb));
  const yLogMin = Math.floor(log10(yMin) * 2) / 2;
  const yLogMax = Math.ceil(log10(yMax) * 2) / 2;

  // 데이터 값을 SVG의 실제 그리기 좌표로 바꾼다. y축만 로그 변환한다.
  const xAt = (score) => pad.left + ((score - xMin) / (xMax - xMin)) * plotW;
  const yAt = (bid) => pad.top + plotH - ((log10(bid) - yLogMin) / (yLogMax - yLogMin)) * plotH;

  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`, class: 'scatter', role: 'img',
    'aria-label': `점수와 파운드당 낙찰가의 관계. 로트 ${usable.length}건. 세로축은 로그 눈금.`
  });

  // ── 격자와 눈금 ──────────────────────────────────────────
  const grid = svgEl('g', { class: 'scatter__grid' });

  for (let score = xMin; score <= xMax; score += 1) {
    const x = xAt(score);
    grid.append(svgEl('line', { x1: x, y1: pad.top, x2: x, y2: pad.top + plotH, class: 'scatter__gridline' }));
    const label = svgEl('text', { x, y: pad.top + plotH + 20, 'text-anchor': 'middle', class: 'scatter__tick' });
    label.textContent = String(score);
    grid.append(label);
  }

  // 로그축 눈금은 1, 2, 5의 배수 자리에만 둔다. 균등 간격으로 두면 뜻이 없다.
  for (const tick of [4, 10, 20, 50, 100, 150]) {
    if (log10(tick) < yLogMin || log10(tick) > yLogMax) continue;
    const y = yAt(tick);
    grid.append(svgEl('line', { x1: pad.left, y1: y, x2: pad.left + plotW, y2: y, class: 'scatter__gridline' }));
    const label = svgEl('text', { x: pad.left - 10, y: y + 4, 'text-anchor': 'end', class: 'scatter__tick' });
    label.textContent = `$${tick}`;
    grid.append(label);
  }
  svg.append(grid);

  // 축 이름
  const xTitle = svgEl('text', {
    x: pad.left + plotW / 2, y: height - 6, 'text-anchor': 'middle', class: 'scatter__axis-title'
  });
  xTitle.textContent = '커핑 총점';
  const yTitle = svgEl('text', {
    x: 14, y: pad.top + plotH / 2, 'text-anchor': 'middle', class: 'scatter__axis-title',
    transform: `rotate(-90 14 ${pad.top + plotH / 2})`
  });
  yTitle.textContent = '파운드당 낙찰가 (로그 눈금)';
  svg.append(xTitle, yTitle);

  // ── 점 ───────────────────────────────────────────────────
  const dots = svgEl('g', { class: 'scatter__dots' });
  for (const point of usable) {
    const marker = markerAt(
      seriesShape(point.process_key),
      xAt(point.score),
      yAt(point.bid_per_lb),
      11,
      { class: 'scatter__dot', fill: seriesColor(point.process_key) }
    );
    // 겹친 점이 서로 뭉개지지 않도록 표면색 테두리를 두른다.
    marker.setAttribute('stroke', 'var(--surface)');
    marker.setAttribute('stroke-width', '2');
    marker.dataset.id = point.id;
    marker.dataset.label =
      `${point.farm} · ${point.score.toFixed(2)}점 · $${point.bid_per_lb.toFixed(2)}/lb · ${processLabels.get(point.process_key) ?? point.process_key}`;

    if (onSelect) {
      marker.setAttribute('tabindex', '0');
      marker.setAttribute('role', 'button');
      marker.setAttribute('aria-label', marker.dataset.label);
    }
    dots.append(marker);
  }
  svg.append(dots);

  // ── 툴팁 ─────────────────────────────────────────────────
  const frame = document.createElement('div');
  frame.className = 'scatter-frame';
  const tooltip = document.createElement('div');
  tooltip.className = 'chart-tooltip';
  tooltip.hidden = true;
  frame.append(svg, tooltip);

  // 점의 설명과 위치를 읽어 해당 점 바로 위에 툴팁을 표시한다.
  const showTooltip = (target) => {
    tooltip.textContent = target.dataset.label;
    tooltip.hidden = false;
    // viewBox 좌표를 화면 비율로 환산해 프레임 안에 띄운다.
    const box = target.getBBox?.();
    if (!box) return;
    tooltip.style.left = `${((box.x + box.width / 2) / width) * 100}%`;
    tooltip.style.top = `${(box.y / height) * 100}%`;
  };
  // 포인터나 키보드 포커스가 점에서 벗어나면 툴팁을 감춘다.
  const hideTooltip = () => { tooltip.hidden = true; };

  // 점마다 리스너를 달지 않고 묶음 하나에서 받는다.
  dots.addEventListener('mouseover', (event) => {
    const dot = event.target.closest('.scatter__dot');
    if (dot) showTooltip(dot);
  });
  dots.addEventListener('mouseout', hideTooltip);
  dots.addEventListener('focusin', (event) => {
    const dot = event.target.closest('.scatter__dot');
    if (dot) showTooltip(dot);
  });
  dots.addEventListener('focusout', hideTooltip);

  if (onSelect) {
    dots.addEventListener('click', (event) => {
      const dot = event.target.closest('.scatter__dot');
      if (dot) onSelect(dot.dataset.id);
    });
    // 키보드로도 열 수 있어야 한다.
    dots.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const dot = event.target.closest('.scatter__dot');
      if (!dot) return;
      event.preventDefault();
      onSelect(dot.dataset.id);
    });
  }

  container.append(frame);

  // 색 대비가 낮은 계열이 있어 범례를 반드시 함께 둔다.
  const used = [...new Set(usable.map((p) => p.process_key))];
  container.append(renderLegend(used.map((key) => ({
    label: processLabels.get(key) ?? key,
    color: seriesColor(key),
    shape: seriesShape(key)
  }))));

  return svg;
}

// 그릴 값이 없을 때 자리에 넣는 안내 문구.
function createEmptyNote(text) {
  const p = document.createElement('p');
  p.className = 'state';
  p.textContent = text;
  return p;
}

export default renderRadar;
