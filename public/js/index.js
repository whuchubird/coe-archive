// index.html — 메인.
// 네 영역이 서로 독립적이라 각각 따로 불러오고, 하나가 실패해도 나머지는 그대로 보이게 한다.
import {
  layoutReady, api, getCurrentUser,
  createEl, clearChildren, renderLotCard,
  showError, showEmpty, formatScore, formatUsd, formatNumber, formatDate
} from './common.js';

const FEATURED_COUNT = 8;
const RECENT_NOTE_COUNT = 3;

const heroSlot = document.querySelector('[data-hero-lot]');
const overviewSlot = document.querySelector('[data-overview]');
const featuredSlot = document.querySelector('[data-featured]');
const processSlot = document.querySelector('[data-processes]');
const notesSlot = document.querySelector('[data-recent-notes]');

// ============================================================
// 히어로 — 최고 낙찰가 로트
// ============================================================

// 정렬과 개수 제한을 서버에 맡긴다. 74건을 받아 와 프론트에서 최댓값을 찾지 않는다.
async function loadHeroLot() {
  try {
    const { items } = await api.get('/beans?sort=bid&order=desc&limit=1');
    clearChildren(heroSlot);
    if (items.length === 0) return showEmpty(heroSlot, '표시할 로트가 없습니다.');
    heroSlot.append(renderLotCard(items[0], { headingTag: 'h2' }));
  } catch (error) {
    showError(heroSlot, error, loadHeroLot);
  }
}

// 총계·평균은 SQL 집계 결과를 그대로 받는다.
async function loadOverview() {
  try {
    const data = await api.get('/stats/overview');
    clearChildren(overviewSlot);

    const cells = [
      ['수상 로트', `${formatNumber(data.total_beans)}건`],
      ['평균 점수', formatScore(data.avg_score)],
      ['최고 낙찰가', `${formatUsd(data.max_bid_per_lb)} /lb`],
      ['한국 업체 낙찰', `${formatNumber(data.korean_count)}건`]
    ];

    for (const [term, value] of cells) {
      overviewSlot.append(
        createEl('div', {
          className: 'stat',
          children: [
            createEl('dt', { className: 'label', text: term }),
            createEl('dd', { className: 'stat__value num', text: value })
          ]
        })
      );
    }
  } catch {
    // 보조 지표라 실패해도 조용히 비워 둔다. 히어로 로트가 이미 핵심을 보여준다.
    clearChildren(overviewSlot);
  }
}

// ============================================================
// 추천 로트 캐러셀
// ============================================================

async function loadFeatured() {
  clearChildren(featuredSlot);
  for (let i = 0; i < 4; i += 1) {
    featuredSlot.append(createEl('div', { className: 'skeleton', attrs: { 'aria-hidden': 'true' } }));
  }

  try {
    const { items } = await api.get(`/beans?sort=score&order=desc&limit=${FEATURED_COUNT}`);
    clearChildren(featuredSlot);
    if (items.length === 0) return showEmpty(featuredSlot, '표시할 로트가 없습니다.');
    for (const bean of items) featuredSlot.append(renderLotCard(bean));
  } catch (error) {
    showError(featuredSlot, error, loadFeatured);
  }
}

// ============================================================
// 가공방식 5종
// ============================================================

// 가공방식 설명은 마스터에서, 건수·평균은 집계에서 받아 하나로 합친다.
async function loadProcesses() {
  try {
    const [processes, byProcess] = await Promise.all([
      api.get('/processes'),
      api.get('/stats/by-process')
    ]);

    const statsByKey = new Map(byProcess.map((row) => [row.key, row]));

    clearChildren(processSlot);
    for (const process of processes) {
      const stat = statsByKey.get(process.key);

      // 가공방식을 고른 채로 아카이브를 열도록 링크에 조건을 실어 보낸다.
      const card = createEl('a', {
        className: 'process-card',
        attrs: { href: `/beans.html?process=${encodeURIComponent(process.key)}` }
      });

      card.append(
        createEl('p', { className: 'label', text: process.name_en }),
        createEl('h3', { className: 'process-card__name', text: process.name_ko }),
        createEl('p', { className: 'process-card__summary', text: process.summary ?? '' }),
        createEl('p', {
          className: 'process-card__figures num',
          text: stat
            ? `${formatNumber(stat.count)}건 · 평균 ${formatScore(stat.avg_score)} · ${formatUsd(stat.avg_bid_per_lb)}`
            : ''
        })
      );

      processSlot.append(card);
    }
  } catch (error) {
    showError(processSlot, error, loadProcesses);
  }
}

// ============================================================
// 최근 노트 3건 (로그인 시)
// ============================================================

async function loadRecentNotes() {
  // 비로그인이면 섹션 자체가 CSS로 숨겨져 있어 요청할 이유가 없다.
  if (!getCurrentUser()) return;

  try {
    const notes = await api.get('/notes');
    clearChildren(notesSlot);

    if (notes.length === 0) {
      return showEmpty(notesSlot, '아직 작성한 노트가 없습니다. 로트를 골라 첫 노트를 남겨 보세요.');
    }

    const list = createEl('ul', { className: 'note-list', attrs: { role: 'list' } });

    // 서버가 이미 최신순으로 정렬해 준다. 여기서는 앞의 세 건만 잘라 보여준다.
    for (const note of notes.slice(0, RECENT_NOTE_COUNT)) {
      const item = createEl('li', { className: 'note-item' });

      item.append(
        createEl('a', {
          className: 'note-item__bean',
          text: note.farm,
          attrs: { href: `/detail.html?id=${encodeURIComponent(note.bean_id)}` }
        }),
        createEl('p', {
          className: 'note-item__meta num',
          text: `${'★'.repeat(note.rating)}${'☆'.repeat(5 - note.rating)} · ${note.brew_method ?? '추출 방식 미기록'} · ${formatDate(note.created_at)}`
        }),
        createEl('p', { className: 'note-item__comment', text: note.comment ?? '' })
      );

      list.append(item);
    }

    notesSlot.append(list);
  } catch (error) {
    showError(notesSlot, error, loadRecentNotes);
  }
}

// ============================================================
// 시작
// ============================================================

// 로그인 상태를 먼저 확정해야 최근 노트를 부를지 판단할 수 있다.
await layoutReady;

// 네 영역은 서로를 기다릴 이유가 없어 동시에 부른다.
await Promise.all([
  loadHeroLot(),
  loadOverview(),
  loadFeatured(),
  loadProcesses(),
  loadRecentNotes()
]);
