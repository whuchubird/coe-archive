// guide.html — 가공방식 가이드.
// 설명·비교표 수치는 전부 /api/processes에서 온다. 페이지에 글을 박아 두지 않는다.
// 마스터 데이터가 바뀌면 화면도 같이 바뀌어야 하기 때문이다.
import {
  layoutReady, api, createEl, clearChildren, showError, formatScore, formatUsd, formatNumber
} from './common.js';
import { seriesColor } from './chart.js';

const tocList = document.querySelector('[data-toc]');
const compareTable = document.querySelector('[data-compare-table]');
const accordion = document.querySelector('[data-accordion]');

// 비교표에 쓰는 네 가지 특성. 컬럼 이름과 순서를 여기서 한 번만 정한다.
const TRAITS = [
  { key: 'acidity', label: '산미' },
  { key: 'body', label: '바디' },
  { key: 'sweetness', label: '단맛' },
  { key: 'cleanliness', label: '깔끔함' }
];

const MAX_TRAIT = 5;

// ============================================================
// 비교표
// ============================================================

// 숫자만 늘어놓으면 비교가 어려워 작은 막대를 함께 그린다.
function traitCell(value) {
  const cell = createEl('td', { className: 'trait-cell' });
  if (value === null || value === undefined) {
    cell.textContent = '—';
    return cell;
  }

  const track = createEl('div', { className: 'trait-bar' });
  const fill = createEl('div', { className: 'trait-bar__fill' });
  fill.style.width = `${(value / MAX_TRAIT) * 100}%`;
  track.append(fill);

  cell.append(createEl('span', { className: 'num trait-cell__value', text: String(value) }), track);
  return cell;
}

// 특성 비교표를 그린다. 숫자와 작은 막대를 함께 두어 크기 차이가 눈에 들어오게 한다.
function renderCompare(processes) {
  clearChildren(compareTable);

  const thead = createEl('thead');
  const headRow = createEl('tr');
  headRow.append(createEl('th', { text: '가공방식', attrs: { scope: 'col' } }));
  for (const trait of TRAITS) {
    headRow.append(createEl('th', { text: trait.label, attrs: { scope: 'col' } }));
  }
  thead.append(headRow);

  const tbody = createEl('tbody');
  for (const process of processes) {
    const row = createEl('tr');
    const name = createEl('th', { attrs: { scope: 'row' } });
    // 방식마다 색 표식을 달아 통계 페이지의 도넛·산점도와 같은 색으로 읽히게 한다.
    const dot = createEl('span', { className: 'series-dot' });
    dot.style.background = seriesColor(process.key);
    name.append(dot, createEl('span', { text: process.name_ko }));
    row.append(name);

    for (const trait of TRAITS) row.append(traitCell(process[trait.key]));
    tbody.append(row);
  }

  compareTable.append(thead, tbody);
}

// ============================================================
// 목차 + 아코디언
// ============================================================

function renderToc(processes) {
  clearChildren(tocList);
  for (const process of processes) {
    tocList.append(createEl('li', {
      children: [createEl('a', {
        className: 'guide-toc__link',
        text: process.name_ko,
        attrs: { href: `#p-${process.key}` }
      })]
    }));
  }
}

// <details>를 쓰면 열고 닫는 동작을 브라우저가 처리한다. JS로 상태를 들고 있을 이유가 없다.
function renderAccordion(processes, statsByKey, samplesByKey) {
  clearChildren(accordion);

  for (const [index, process] of processes.entries()) {
    const item = createEl('details', { className: 'guide-item', attrs: { id: `p-${process.key}` } });
    // 첫 항목만 열어 둔다. 전부 열면 목차가 의미가 없고, 전부 닫으면 비어 보인다.
    if (index === 0) item.setAttribute('open', '');

    const summary = createEl('summary', { className: 'guide-item__summary' });
    const dot = createEl('span', { className: 'series-dot' });
    dot.style.background = seriesColor(process.key);
    summary.append(
      dot,
      createEl('span', { className: 'guide-item__name', text: process.name_ko }),
      createEl('span', { className: 'guide-item__en', text: process.name_en })
    );

    const stat = statsByKey.get(process.key);
    if (stat) {
      summary.append(createEl('span', {
        className: 'guide-item__count num',
        text: `${formatNumber(stat.count)}건`
      }));
    }

    const body = createEl('div', { className: 'guide-item__body' });
    body.append(createEl('p', { className: 'guide-item__summary-text', text: process.summary ?? '' }));
    if (process.detail) body.append(createEl('p', { className: 'guide-item__detail', text: process.detail }));

    if (stat) {
      body.append(createEl('p', {
        className: 'muted num',
        text: `평균 ${formatScore(stat.avg_score)} · 평균 낙찰가 ${formatUsd(stat.avg_bid_per_lb)} · 최고 ${formatUsd(stat.max_bid_per_lb)}`
      }));
    }

    // 대표 로트 — 이 방식에서 점수가 가장 높은 세 건.
    const samples = samplesByKey.get(process.key) ?? [];
    if (samples.length > 0) {
      const list = createEl('ul', { className: 'guide-samples', attrs: { role: 'list' } });
      for (const bean of samples) {
        list.append(createEl('li', {
          children: [
            createEl('a', {
              className: 'guide-samples__link',
              text: bean.farm,
              attrs: { href: `/detail.html?id=${encodeURIComponent(bean.id)}` }
            }),
            createEl('span', {
              className: 'muted num',
              text: ` ${formatScore(bean.score)} · ${formatUsd(bean.bid_per_lb)}`
            })
          ]
        }));
      }
      body.append(createEl('p', { className: 'label', text: '대표 로트' }), list);
    }

    body.append(createEl('a', {
      className: 'btn btn--sm',
      text: `${process.name_ko} 로트 모두 보기`,
      attrs: { href: `/beans.html?process=${encodeURIComponent(process.key)}` }
    }));

    item.append(summary, body);
    accordion.append(item);
  }
}

// ============================================================
// 스크롤 스파이 — 지금 보고 있는 절을 목차에 표시
// ============================================================

function setupScrollSpy() {
  const items = [...accordion.querySelectorAll('.guide-item')];
  const links = new Map(
    [...tocList.querySelectorAll('.guide-toc__link')].map((a) => [a.getAttribute('href').slice(1), a])
  );

  // 스크롤 이벤트를 직접 듣지 않고 IntersectionObserver에 맡긴다.
  // 매 프레임 위치를 계산하지 않아 스크롤이 무겁지 않다.
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const link = links.get(entry.target.id);
      if (!link) continue;
      if (entry.isIntersecting) {
        for (const other of links.values()) other.removeAttribute('aria-current');
        link.setAttribute('aria-current', 'true');
      }
    }
  }, {
    // 화면 위쪽 30% 지점을 지나는 절을 "지금 보는 절"로 친다.
    rootMargin: '-20% 0px -70% 0px'
  });

  for (const item of items) observer.observe(item);
}

// ============================================================
// 시작
// ============================================================

await layoutReady;

try {
  // 설명은 마스터에서, 건수·평균은 집계에서 가져와 합친다.
  const [processes, byProcess] = await Promise.all([
    api.get('/processes'),
    api.get('/stats/by-process')
  ]);

  const statsByKey = new Map(byProcess.map((row) => [row.key, row]));

  // 방식별 대표 로트 3건씩. 서버에 점수 내림차순·3건으로 요청해 프론트에서 고르지 않는다.
  const sampleLists = await Promise.all(
    processes.map((process) =>
      api.get(`/beans?process=${encodeURIComponent(process.key)}&sort=score&order=desc&limit=3`)
        .then((result) => [process.key, result.items])
        .catch(() => [process.key, []])
    )
  );
  const samplesByKey = new Map(sampleLists);

  renderToc(processes);
  renderCompare(processes);
  renderAccordion(processes, statsByKey, samplesByKey);
  setupScrollSpy();
} catch (error) {
  showError(accordion, error, () => location.reload());
}
