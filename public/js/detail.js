// detail.html — 로트 한 건의 상세.
// ?id=BR25W01 처럼 주소에 담긴 로트를 조회해 그린다.
import {
  layoutReady, api, ApiError, getCurrentUser,
  createEl, clearChildren, renderLotCard,
  showError, showEmpty, showLoading,
  formatScore, formatUsd, formatWeight, formatNumber, formatRank,
  formatDecimal, formatDate, scrollToStart
} from './common.js';
import { renderRadar } from './chart.js';

const detailSlot = document.querySelector('[data-detail]');
const similarSlot = document.querySelector('[data-similar]');
const notesSlot = document.querySelector('[data-bean-notes]');
const notesSummarySlot = document.querySelector('[data-notes-summary]');
const notesPaginationSlot = document.querySelector('[data-notes-pagination]');

// 노트 목록이 보고 있는 페이지. 주소에는 넣지 않는다 —
// 이 화면의 주된 상태는 로트 id이고, 노트 페이지까지 주소에 담으면 공유 링크의 뜻이 흐려진다.
let notePage = 1;
// 페이지 버튼을 빠르게 눌러 응답 순서가 뒤집혀도 마지막 요청만 화면을 바꾸게 한다.
let noteRequestId = 0;

// 카드에 가로 막대로 그릴 감각 6축. 카드마다 레이더를 그리면 열 개가 한 화면에서 다툰다.
const NOTE_AXES = [
  { key: 'aroma', label: '향' },
  { key: 'acidity', label: '산미' },
  { key: 'body', label: '바디' },
  { key: 'sweetness', label: '단맛' },
  { key: 'aftertaste', label: '여운' },
  { key: 'balance', label: '밸런스' }
];
const AXIS_MAX = 5;

// 주소에서 로트 id를 꺼낸다.
const beanId = new URLSearchParams(location.search).get('id');

// 즐겨찾기 버튼은 로트를 그린 뒤에 만들어지므로 여기 담아 둔다.
let favoriteButton = null;
let isFavorite = false;

// ============================================================
// 작은 조각들
// ============================================================

// 라벨 + 값 한 쌍. 전표의 항목처럼 라벨을 작게 위에 둔다.
function figure(label, value, { mono = true, className = '' } = {}) {
  return createEl('div', {
    className: `figure ${className}`.trim(),
    children: [
      createEl('p', { className: 'label', text: label }),
      createEl('p', { className: mono ? 'figure__value num' : 'figure__value', text: value })
    ]
  });
}

// 태그 목록(품종·향미). 값이 없으면 아예 만들지 않는다.
function tagList(items) {
  const list = createEl('ul', { className: 'tag-list', attrs: { role: 'list' } });
  for (const item of items) {
    list.append(createEl('li', { children: [createEl('span', { className: 'tag', text: item })] }));
  }
  return list;
}

// 낙찰 업체. 한국 업체는 표시를 달리해 눈에 띄게 한다.
function buyerList(buyers) {
  const list = createEl('ul', { className: 'buyer-list', attrs: { role: 'list' } });
  for (const buyer of buyers) {
    list.append(createEl('li', {
      className: buyer.is_korean ? 'buyer buyer--korean' : 'buyer',
      text: buyer.is_korean ? `${buyer.name} · 한국` : buyer.name
    }));
  }
  return list;
}

// ============================================================
// 즐겨찾기
// ============================================================

function updateFavoriteButton() {
  if (!favoriteButton) return;
  favoriteButton.textContent = isFavorite ? '★ 즐겨찾기 해제' : '☆ 즐겨찾기';
  favoriteButton.setAttribute('aria-pressed', String(isFavorite));
}

// 로그인 상태에서만 현재 상태를 확인한다. 비로그인이면 물어볼 것도 없다.
async function loadFavoriteState() {
  if (!getCurrentUser()) return;
  try {
    const favorites = await api.get('/favorites');
    isFavorite = favorites.some((row) => row.bean_id === beanId);
    updateFavoriteButton();
  } catch {
    // 확인에 실패해도 페이지를 막지 않는다. 버튼은 담기 상태로 둔다.
  }
}

// 즐겨찾기를 담거나 뺀다. 요청 중에는 버튼을 잠가 연타로 두 번 나가지 않게 한다.
async function toggleFavorite() {
  favoriteButton.disabled = true;
  try {
    if (isFavorite) {
      // 서버는 이미 빠져 있었는지(removed:false)까지 알려주지만,
      // 어느 쪽이든 요청 뒤에는 담겨 있지 않은 상태다.
      await api.del(`/favorites/${encodeURIComponent(beanId)}`);
      isFavorite = false;
    } else {
      await api.post(`/favorites/${encodeURIComponent(beanId)}`);
      isFavorite = true;
    }
    updateFavoriteButton();
  } catch (error) {
    // 세션이 만료돼 401이 오면 로그인 페이지로 안내한다.
    if (error instanceof ApiError && error.isUnauthorized) {
      location.href = `/login.html?next=${encodeURIComponent(location.pathname + location.search)}`;
      return;
    }
    alert(error instanceof ApiError ? error.message : '즐겨찾기를 변경하지 못했습니다.');
  } finally {
    favoriteButton.disabled = false;
  }
}

// 로그인 여부에 따라 버튼이 달라진다.
// 비로그인에게 눌리는 버튼을 보여주고 401을 띄우는 대신, 처음부터 로그인으로 안내한다.
function renderFavoriteControl() {
  if (!getCurrentUser()) {
    return createEl('a', {
      className: 'btn btn--ghost',
      text: '☆ 로그인하고 즐겨찾기',
      attrs: { href: `/login.html?next=${encodeURIComponent(location.pathname + location.search)}` }
    });
  }

  favoriteButton = createEl('button', {
    className: 'btn',
    attrs: { type: 'button', 'aria-pressed': 'false' }
  });
  favoriteButton.addEventListener('click', toggleFavorite);
  updateFavoriteButton();
  return favoriteButton;
}

// ============================================================
// 상세 그리기
// ============================================================

function renderDetail(bean) {
  clearChildren(detailSlot);

  const isNationalWinner = bean.rank === null || bean.rank === undefined;

  // ── 머리말 : 순위 도장 + 농장명 + 산지 ──────────────────
  const heading = createEl('div', {
    className: 'detail__head',
    children: [
      createEl('div', {
        className: isNationalWinner ? 'lot__rank lot__rank--nw' : 'lot__rank',
        text: formatRank(bean.rank, bean.award)
      }),
      createEl('div', {
        children: [
          // 값이 없는 항목은 빼고 이어 붙인다. 그냥 잇면 " · "가 끝에 남는다.
          createEl('p', {
            className: 'label',
            text: [bean.award, bean.year, bean.category_ko].filter(Boolean).join(' · ')
          }),
          createEl('h1', { className: 'serif detail__farm', text: bean.farm }),
          createEl('p', {
            className: 'detail__origin',
            text: [bean.country_ko, bean.region].filter(Boolean).join(' · ')
          }),
          createEl('p', { className: 'muted', text: bean.farmer ? `생산자 ${bean.farmer}` : '' })
        ]
      })
    ]
  });

  // ── 숫자 : 점수·낙찰가·중량·총액 ────────────────────────
  const figures = createEl('div', {
    className: 'detail__figures',
    children: [
      figure('총점', formatScore(bean.score), { className: 'figure--lead' }),
      figure('파운드당 낙찰가', formatUsd(bean.bid_per_lb), { className: 'figure--bid' }),
      figure('중량', formatWeight(bean.weight_lb)),
      figure('총 낙찰액', formatUsd(bean.total_value_usd)),
      figure('로트 ID', bean.id),
      figure('가공방식', bean.process_name_ko ?? '', { mono: false })
    ]
  });

  // ── 왼쪽 : 레이더 차트 ──────────────────────────────────
  const chartCard = createEl('section', {
    className: 'panel',
    children: [
      createEl('h2', { className: 'panel__title', text: '감각 프로필' }),
      createEl('p', { className: 'muted', text: '공식 데이터가 아닌 추정치입니다.' })
    ]
  });
  const chartSlot = createEl('div', { className: 'radar-slot' });
  chartCard.append(chartSlot);

  // ── 오른쪽 : 품종·향미·업체 ─────────────────────────────
  const infoCard = createEl('section', { className: 'panel' });
  infoCard.append(createEl('h2', { className: 'panel__title', text: '로트 정보' }));

  const varieties = bean.varieties ?? [];
  infoCard.append(createEl('div', {
    className: 'panel__row',
    children: [
      createEl('p', { className: 'label', text: '품종' }),
      varieties.length > 0 ? tagList(varieties) : createEl('p', { className: 'muted', text: '정보 없음' })
    ]
  }));

  const flavors = bean.flavor_notes ?? [];
  infoCard.append(createEl('div', {
    className: 'panel__row',
    children: [
      createEl('p', { className: 'label', text: '향미 (추정)' }),
      flavors.length > 0 ? tagList(flavors) : createEl('p', { className: 'muted', text: '정보 없음' })
    ]
  }));

  const buyers = bean.buyers ?? [];
  infoCard.append(createEl('div', {
    className: 'panel__row',
    children: [
      createEl('p', { className: 'label', text: `낙찰 업체 ${formatNumber(buyers.length)}곳` }),
      buyers.length > 0 ? buyerList(buyers) : createEl('p', { className: 'muted', text: '정보 없음' })
    ]
  }));

  if (bean.process_summary) {
    infoCard.append(createEl('div', {
      className: 'panel__row',
      children: [
        createEl('p', { className: 'label', text: `${bean.process_name_ko} 가공` }),
        createEl('p', { className: 'panel__text', text: bean.process_summary })
      ]
    }));
  }

  // ── 동작 : 즐겨찾기 · 노트 작성 ─────────────────────────
  const actions = createEl('div', {
    className: 'detail__actions',
    children: [
      renderFavoriteControl(),
      createEl('a', {
        className: 'btn btn--primary',
        text: '이 로트로 노트 쓰기',
        attrs: { href: `/notes.html?bean=${encodeURIComponent(bean.id)}` }
      })
    ]
  });

  detailSlot.append(
    heading,
    figures,
    actions,
    createEl('div', { className: 'detail__panels', children: [chartCard, infoCard] })
  );

  // 차트는 요소가 문서에 붙은 뒤에 그린다.
  renderRadar(chartSlot, bean.sensory, { title: `${bean.farm} 감각 프로필` });
}

// ============================================================
// 불러오기
// ============================================================

async function loadDetail() {
  try {
    const bean = await api.get(`/beans/${encodeURIComponent(beanId)}`);
    document.title = `${bean.farm} — COE ARCHIVE`;
    renderDetail(bean);
    await loadFavoriteState();
  } catch (error) {
    showError(detailSlot, error, loadDetail);
  }
}

// 감각 6축이 가까운 로트 3건을 받아 카드로 그린다.
async function loadSimilar() {
  try {
    const items = await api.get(`/beans/${encodeURIComponent(beanId)}/similar`);
    clearChildren(similarSlot);
    if (items.length === 0) return showEmpty(similarSlot, '비교할 로트가 없습니다.');
    for (const bean of items) similarSlot.append(renderLotCard(bean));
  } catch (error) {
    showError(similarSlot, error, loadSimilar);
  }
}

// ============================================================
// 테이스팅 노트
// ============================================================

// 별점을 채운 별과 빈 별로 보여준다.
// 문자로 그리면 숫자보다 한눈에 들어오고, 소수점이 없어 별점의 성격에도 맞는다.
function ratingStars(rating) {
  const value = Number(rating);
  const stars = createEl('span', { className: 'bnote-rating', attrs: { role: 'img' } });
  stars.setAttribute('aria-label', `별점 ${value}점`);
  stars.append(createEl('span', { attrs: { 'aria-hidden': 'true' }, text: '★'.repeat(value) + '☆'.repeat(5 - value) }));
  return stars;
}

// 감각 6축을 가로 막대와 수치로 그린다.
// 값이 없는 축은 줄을 만들지 않는다 — 빈 막대는 0점과 헷갈린다.
function sensoryBars(sensory) {
  const list = createEl('dl', { className: 'bnote-axes' });
  let drawn = 0;

  for (const axis of NOTE_AXES) {
    const value = sensory?.[axis.key];
    if (typeof value !== 'number') continue;
    drawn += 1;

    const bar = createEl('div', { className: 'bnote-axis__bar' });
    const fill = createEl('span', { className: 'bnote-axis__fill' });
    // 폭은 5점 만점 대비 비율이다. 인라인 스타일을 쓰는 것은 값마다 달라지기 때문이다.
    fill.style.width = `${Math.max(0, Math.min(1, value / AXIS_MAX)) * 100}%`;
    bar.append(fill);

    list.append(
      createEl('dt', { className: 'bnote-axis__label', text: axis.label }),
      createEl('dd', {
        className: 'bnote-axis__value',
        children: [bar, createEl('span', { className: 'num', text: formatDecimal(value) })]
      })
    );
  }

  return drawn === 0 ? null : list;
}

// 노트 한 건을 카드로 만든다.
// 비공개 노트는 서버가 세부 내용을 아예 내려주지 않으므로, 여기서 가릴 것이 없다.
function renderNoteCard(note) {
  const card = createEl('article', {
    className: note.isPublic ? 'bnote-card' : 'bnote-card bnote-card--private'
  });

  const head = createEl('div', { className: 'bnote-card__head' });
  const who = createEl('div', { className: 'bnote-card__who' });
  // 사용자가 정한 아이디이므로 textContent로 넣는다.
  who.append(createEl('span', { className: 'bnote-card__user', text: note.username }));
  if (note.isMine) who.append(createEl('span', { className: 'badge badge--mine', text: '내 노트' }));
  if (!note.isPublic) who.append(createEl('span', { className: 'badge', text: '비공개' }));

  head.append(
    who,
    createEl('div', {
      className: 'bnote-card__meta',
      children: [ratingStars(note.rating), createEl('time', {
        className: 'muted',
        text: formatDate(note.createdAt),
        attrs: { datetime: note.createdAt }
      })]
    })
  );
  card.append(head);

  // 세부 내용이 없다는 것은 비공개라는 뜻이다(본인 노트는 항상 내용이 온다).
  const hidden = !note.isPublic && !note.isMine;
  if (hidden) {
    card.append(createEl('p', { className: 'bnote-card__locked muted', text: '🔒 비공개 노트입니다' }));
    return card;
  }

  if (note.brewMethod) {
    card.append(createEl('p', {
      className: 'bnote-card__brew',
      children: [createEl('span', { className: 'badge badge--brew', text: note.brewMethod })]
    }));
  }
  if (note.comment) {
    card.append(createEl('p', { className: 'bnote-card__comment', text: note.comment }));
  }

  const axes = sensoryBars(note.sensory);
  if (axes) card.append(axes);

  if (note.isMine) {
    card.append(createEl('p', {
      className: 'bnote-card__actions',
      children: [createEl('a', {
        text: '노트 수정',
        attrs: { href: `/notes.html?edit=${encodeURIComponent(note.id)}` }
      })]
    }));
  }
  return card;
}

// 노트가 없을 때. 로그인 여부에 따라 다음 행동을 다르게 안내한다.
function renderEmptyNotes() {
  const box = createEl('div', { className: 'state bnote-empty' });
  box.append(createEl('p', { text: '아직 작성된 노트가 없습니다.' }));

  box.append(getCurrentUser()
    ? createEl('a', {
      className: 'btn btn--sm',
      text: '첫 노트 남기기',
      attrs: { href: `/notes.html?bean=${encodeURIComponent(beanId)}` }
    })
    : createEl('a', {
      className: 'btn btn--sm',
      text: '로그인하고 노트 쓰기',
      attrs: { href: `/login.html?next=${encodeURIComponent(location.pathname + location.search)}` }
    }));

  notesSlot.append(box);
}

// 페이지 버튼. beans.html과 같은 모양·같은 동작을 쓴다.
function renderNotePagination(page, totalPages) {
  clearChildren(notesPaginationSlot);
  if (totalPages <= 1) return;

  const go = (target) => {
    notePage = target;
    loadNotes();
    // 노트 섹션 머리로만 올린다. 페이지 전체를 위로 올리면 보고 있던 로트 정보가 사라진다.
    scrollToStart(document.querySelector('#notes-section'));
  };

  const addButton = (label, target, { disabled = false, current = false } = {}) => {
    const button = createEl('button', {
      className: current ? 'page-btn page-btn--current' : 'page-btn',
      text: label,
      attrs: { type: 'button', ...(current ? { 'aria-current': 'page' } : {}) }
    });
    button.disabled = disabled;
    if (!disabled && !current) button.addEventListener('click', () => go(target));
    notesPaginationSlot.append(button);
  };

  addButton('‹', page - 1, { disabled: page === 1 });

  const numbers = new Set([1, totalPages, page, page - 1, page + 1]);
  const visible = [...numbers].filter((n) => n >= 1 && n <= totalPages).sort((a, b) => a - b);

  let previous = 0;
  for (const number of visible) {
    if (number - previous > 1) notesPaginationSlot.append(createEl('span', { className: 'page-gap', text: '…' }));
    addButton(String(number), number, { current: number === page });
    previous = number;
  }

  addButton('›', page + 1, { disabled: page === totalPages });
}

// 헤더의 "37건 · 평균 ★4.3".
function renderNotesSummary({ count, avgRating }) {
  if (count === 0) {
    notesSummarySlot.textContent = '아직 노트가 없습니다';
    return;
  }
  notesSummarySlot.textContent = avgRating === null
    ? `${formatNumber(count)}건`
    : `${formatNumber(count)}건 · 평균 ★${formatDecimal(avgRating)}`;
}

// 현재 페이지의 노트를 받아 그린다.
async function loadNotes() {
  const requestId = ++noteRequestId;
  const requestedPage = notePage;
  clearChildren(notesSlot);
  showLoading(notesSlot, 3);

  try {
    const result = await api.get(
      `/beans/${encodeURIComponent(beanId)}/notes?page=${requestedPage}&limit=10`
    );
    if (requestId !== noteRequestId) return;

    // 마지막 페이지의 노트가 다른 화면에서 삭제된 경우 빈 상태로 오해하지 않고
    // 현재 존재하는 마지막 페이지로 한 번 이동한다.
    if (result.total > 0 && result.items.length === 0 && requestedPage > result.totalPages) {
      notePage = result.totalPages;
      return loadNotes();
    }

    notePage = result.page;
    clearChildren(notesSlot);
    renderNotesSummary(result.summary);

    if (result.items.length === 0) {
      renderEmptyNotes();
      clearChildren(notesPaginationSlot);
      return;
    }

    const list = createEl('div', { className: 'bnote-list' });
    for (const note of result.items) list.append(renderNoteCard(note));
    notesSlot.append(list);

    renderNotePagination(result.page, result.totalPages);
  } catch (error) {
    if (requestId !== noteRequestId) return;
    clearChildren(notesSlot);
    clearChildren(notesPaginationSlot);
    notesSummarySlot.textContent = '';
    showError(notesSlot, error, loadNotes);
  }
}

// ============================================================
// 시작
// ============================================================

await layoutReady;

if (!beanId) {
  // 주소에 id가 없으면 조회할 대상이 없다. 목록으로 돌아갈 길을 보여준다.
  clearChildren(detailSlot);
  detailSlot.append(createEl('div', {
    className: 'state state--error',
    attrs: { role: 'alert' },
    children: [
      createEl('p', { text: '로트가 지정되지 않았습니다.' }),
      createEl('a', { className: 'btn btn--sm', text: '아카이브로 가기', attrs: { href: '/beans.html' } })
    ]
  }));
  clearChildren(similarSlot);
  clearChildren(notesSlot);
  clearChildren(notesPaginationSlot);
} else {
  await Promise.all([loadDetail(), loadSimilar(), loadNotes()]);
}
