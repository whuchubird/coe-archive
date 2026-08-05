// stats.html — 통계.
// 모든 수치는 서버가 GROUP BY·AVG·COUNT로 계산해 내려준 것을 그대로 그린다.
// 여기서 합계를 다시 내거나 평균을 구하지 않는다.
import {
  layoutReady, api, getCurrentUser,
  createEl, clearChildren, showError, showEmpty,
  formatScore, formatUsd, formatNumber, formatDecimal
} from './common.js';
import { renderDonut, renderBar, renderScatter } from './chart.js';

const overviewSlot = document.querySelector('[data-overview]');
const donutSlot = document.querySelector('[data-process-donut]');
const processTable = document.querySelector('[data-process-table]');
const scatterSlot = document.querySelector('[data-scatter]');
const correlationSlot = document.querySelector('[data-correlation]');
const countryBars = document.querySelector('[data-country-bars]');
const countryTable = document.querySelector('[data-country-table]');
const varietyBars = document.querySelector('[data-variety-bars]');
const koreanTable = document.querySelector('[data-korean-table]');
const koreanTableWrap = koreanTable.parentElement;
const koreanCount = document.querySelector('[data-korean-count]');
const mySlot = document.querySelector('[data-my-stats]');

// 가공방식 key → 한글 이름. 여러 곳에서 쓰므로 한 번 받아 둔다.
const processLabels = new Map();

// ============================================================
// 표 만들기 — 대비가 낮은 계열색을 보완하는 "표로도 볼 수 있게" 장치
// ============================================================

function renderTable(table, headers, rows) {
  clearChildren(table);

  const thead = createEl('thead');
  const headRow = createEl('tr');
  for (const [index, header] of headers.entries()) {
    headRow.append(createEl('th', {
      text: header,
      // 첫 칸은 항목 이름, 나머지는 숫자라 오른쪽 정렬한다.
      className: index === 0 ? '' : 'num-cell',
      attrs: { scope: 'col' }
    }));
  }
  thead.append(headRow);

  const tbody = createEl('tbody');
  for (const row of rows) {
    const tr = createEl('tr');
    for (const [index, cell] of row.entries()) {
      tr.append(index === 0
        ? createEl('th', { text: cell, attrs: { scope: 'row' } })
        : createEl('td', { text: cell, className: 'num-cell num' }));
    }
    tbody.append(tr);
  }

  table.append(thead, tbody);
}

// ============================================================
// 총계
// ============================================================

async function loadOverview() {
  try {
    const data = await api.get('/stats/overview');
    clearChildren(overviewSlot);
    const cells = [
      ['수상 로트', `${formatNumber(data.total_beans)}건`],
      ['평균 점수', formatScore(data.avg_score)],
      ['평균 낙찰가', `${formatUsd(data.avg_bid_per_lb)} /lb`],
      ['최고 낙찰가', `${formatUsd(data.max_bid_per_lb)} /lb`],
      ['총 낙찰액', formatUsd(data.total_value_usd)],
      ['한국 업체 낙찰', `${formatNumber(data.korean_count)}건`]
    ];
    for (const [term, value] of cells) {
      overviewSlot.append(createEl('div', {
        className: 'stat',
        children: [
          createEl('dt', { className: 'label', text: term }),
          createEl('dd', { className: 'stat__value num', text: value })
        ]
      }));
    }
  } catch (error) {
    showError(overviewSlot, error, loadOverview);
  }
}

// ============================================================
// 가공방식 — 도넛 + 표
// ============================================================

async function loadByProcess() {
  try {
    const rows = await api.get('/stats/by-process');
    for (const row of rows) processLabels.set(row.key, row.name_ko);

    renderDonut(
      donutSlot,
      rows.map((row) => ({ key: row.key, label: row.name_ko, value: row.count })),
      { centerLabel: String(rows.reduce((sum, r) => sum + r.count, 0)) }
    );

    renderTable(
      processTable,
      ['가공방식', '건수', '평균 점수', '평균 낙찰가', '최고 낙찰가'],
      rows.map((row) => [
        row.name_ko,
        formatNumber(row.count),
        formatScore(row.avg_score),
        formatUsd(row.avg_bid_per_lb),
        formatUsd(row.max_bid_per_lb)
      ])
    );
  } catch (error) {
    showError(donutSlot, error, loadByProcess);
  }
}

// ============================================================
// 산점도
// ============================================================

async function loadScatter() {
  try {
    const points = await api.get('/stats/scatter');
    renderScatter(scatterSlot, points, {
      processLabels,
      xMin: 86,
      xMax: 92,
      // 점을 누르면 그 로트로 간다.
      onSelect: (id) => { location.href = `/detail.html?id=${encodeURIComponent(id)}`; }
    });

    correlationSlot.textContent =
      '세로축은 로그 눈금입니다. 낙찰가가 $4에서 $143까지 벌어져 있어 그대로 그리면 아래쪽에 뭉칩니다. '
      + '점수가 오를수록 낙찰가가 오르는 경향이 있지만, 같은 점수에서도 가격 차이가 큽니다.';
  } catch (error) {
    showError(scatterSlot, error, loadScatter);
  }
}

// ============================================================
// 국가별
// ============================================================

async function loadByCountry() {
  try {
    const rows = await api.get('/stats/by-country');

    // 평균 점수는 86~92 사이에 몰려 있어 0부터 그리면 차이가 안 보인다.
    // 시작점을 86으로 올리고 그 사실을 차트 아래에 밝힌다.
    renderBar(
      countryBars,
      rows.map((row) => ({
        label: row.country_ko,
        value: row.avg_score,
        note: formatScore(row.avg_score)
      })),
      { min: 86, max: 92, unit: '점' }
    );

    renderTable(
      countryTable,
      ['국가', '건수', 'COE', '한국 낙찰', '평균 점수', '평균 낙찰가', '최고 낙찰가'],
      rows.map((row) => [
        row.country_ko,
        formatNumber(row.count),
        formatNumber(row.coe_count),
        formatNumber(row.korean_count),
        formatScore(row.avg_score),
        formatUsd(row.avg_bid_per_lb),
        formatUsd(row.max_bid_per_lb)
      ])
    );
  } catch (error) {
    showError(countryBars, error, loadByCountry);
  }
}

// ============================================================
// 품종 랭킹
// ============================================================

async function loadVarieties() {
  try {
    const rows = await api.get('/stats/varieties');
    // 로트 수는 0부터 세는 값이라 막대를 0에서 시작해도 뜻이 맞는다.
    renderBar(
      varietyBars,
      rows.map((row) => ({
        label: row.name,
        value: row.count,
        note: `${formatNumber(row.count)}건 · ${formatScore(row.avg_score)} · ${formatUsd(row.avg_bid_per_lb)}`
      }))
    );
  } catch (error) {
    showError(varietyBars, error, loadVarieties);
  }
}

// ============================================================
// 한국 업체 낙찰
// ============================================================

async function loadKorean() {
  try {
    const rows = await api.get('/stats/korean');
    koreanCount.textContent = `${formatNumber(rows.length)}건`;

    // 오류 상태는 table-wrap 전체를 교체한다. 재시도에 성공하면 기존 table을
    // 다시 붙여야 renderTable()의 결과가 실제 화면에 나타난다.
    if (!koreanTableWrap.contains(koreanTable)) {
      clearChildren(koreanTableWrap);
      koreanTableWrap.append(koreanTable);
    }

    renderTable(
      koreanTable,
      ['로트', '농장', '국가', '가공방식', '점수', '낙찰가', '한국 업체'],
      rows.map((row) => [
        row.id,
        row.farm,
        row.country_ko,
        row.process_name_ko,
        formatScore(row.score),
        formatUsd(row.bid_per_lb),
        (row.korean_buyers ?? []).join(', ')
      ])
    );
  } catch (error) {
    koreanCount.textContent = '';
    showError(koreanTableWrap, error, loadKorean);
  }
}

// ============================================================
// 내 취향 (로그인 시)
// ============================================================

async function loadMyStats() {
  if (!getCurrentUser()) return;

  try {
    const data = await api.get('/stats/my');
    clearChildren(mySlot);

    if (data.summary.note_count === 0) {
      return showEmpty(mySlot, '노트를 남기면 여기에 취향 요약이 나타납니다.');
    }

    const summary = createEl('dl', { className: 'hero__stats' });
    const cells = [
      ['작성한 노트', `${formatNumber(data.summary.note_count)}건`],
      ['기록한 로트', `${formatNumber(data.summary.bean_count)}종`],
      ['평균 별점', formatDecimal(data.summary.avg_rating, 2)],
      ['선호 가공방식', data.favorite_process ? data.favorite_process.name_ko : '—']
    ];
    for (const [term, value] of cells) {
      summary.append(createEl('div', {
        className: 'stat',
        children: [
          createEl('dt', { className: 'label', text: term }),
          createEl('dd', { className: 'stat__value num', text: value })
        ]
      }));
    }
    mySlot.append(summary);

    if (data.by_process.length > 0) {
      const table = createEl('table', { className: 'data-table' });
      renderTable(
        table,
        ['가공방식', '노트', '평균 별점', '산미', '바디', '단맛'],
        data.by_process.map((row) => [
          row.name_ko,
          formatNumber(row.note_count),
          formatDecimal(row.avg_rating, 2),
          formatDecimal(row.avg_acidity),
          formatDecimal(row.avg_body),
          formatDecimal(row.avg_sweetness)
        ])
      );
      mySlot.append(
        createEl('h3', { className: 'panel__title stats-subtitle', text: '가공방식별' }),
        createEl('div', { className: 'table-wrap', children: [table] })
      );
    }

    if (data.top_flavors.length > 0) {
      const list = createEl('ul', { className: 'tag-list', attrs: { role: 'list' } });
      for (const flavor of data.top_flavors) {
        list.append(createEl('li', {
          children: [createEl('span', { className: 'tag', text: `${flavor.name} ${flavor.count}` })]
        }));
      }
      mySlot.append(
        createEl('h3', { className: 'panel__title stats-subtitle', text: '자주 만난 향미 (추정치 기준)' }),
        list
      );
    }
  } catch (error) {
    showError(mySlot, error, loadMyStats);
  }
}

// ============================================================
// 시작
// ============================================================

await layoutReady;

// 가공방식 이름을 산점도 범례가 쓰므로 먼저 받아 둔다.
await loadByProcess();

await Promise.all([
  loadOverview(),
  loadScatter(),
  loadByCountry(),
  loadVarieties(),
  loadKorean(),
  loadMyStats()
]);
