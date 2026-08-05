// detail.html — 로트 한 건의 상세.
// ?id=BR25W01 처럼 주소에 담긴 로트를 조회해 그린다.
import {
  layoutReady, api, ApiError, getCurrentUser,
  createEl, clearChildren, renderLotCard,
  showError, showEmpty,
  formatScore, formatUsd, formatWeight, formatNumber, formatRank
} from './common.js';
import { renderRadar } from './chart.js';

const detailSlot = document.querySelector('[data-detail]');
const similarSlot = document.querySelector('[data-similar]');

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
} else {
  await Promise.all([loadDetail(), loadSimilar()]);
}
