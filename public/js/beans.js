// beans.html — 아카이브 목록.
//
// 구조는 하나다. state를 바꾼다 → 쿼리스트링을 만든다 → /api/beans를 부른다 → 결과를 그린다.
// 거르고 정렬하고 자르는 일은 전부 서버 SQL이 한다.
// 받아온 74건을 프론트에서 filter()로 다시 거르는 순간 정적 사이트와 다를 게 없어진다.
import {
  layoutReady, api, buildQuery, ApiError,
  createEl, clearChildren, renderLotCard,
  showLoading, showError, showEmpty, formatNumber
} from './common.js';

// ============================================================
// 상태
// ============================================================

// 화면의 모든 조건이 여기 모인다. 주소창·서버 요청·체크박스가 전부 이 객체 하나를 본다.
const state = {
  country: [],
  award: [],
  process: [],
  variety: [],
  q: '',
  minAcidity: 0,
  minBody: 0,
  minSweetness: 0,
  sort: 'score',
  order: 'desc',
  page: 1
};

const PAGE_SIZE = 12;
const SEARCH_DEBOUNCE_MS = 300;

// 정렬 선택값은 'sort:order' 한 문자열로 다룬다. 허용된 조합만 select에 들어 있다.
const SORT_OPTIONS = ['score:desc', 'bid:desc', 'value:desc', 'rank:asc'];

// 체크박스로 다루는 필터. 화면 표시 이름을 붙여 둔다.
const LIST_FILTERS = ['country', 'award', 'process', 'variety'];

// 국가·등급은 코드가 그대로 나와 한글 이름을 따로 붙인다.
// 가공방식·품종은 서버가 준 key를 그대로 쓴다(가공방식은 아래에서 한글 이름을 채운다).
const COUNTRY_LABELS = { Brazil: '브라질', Guatemala: '과테말라' };
const AWARD_LABELS = { COE: 'COE 수상', NW: 'National Winner' };
const processLabels = new Map();

// 조건 없이 받은 전체 옵션 목록. 체크박스에 어떤 항목을 보여줄지는 이걸로 정한다.
// facets 응답만 쓰면 "브라질"을 고른 순간 과테말라가 목록에서 사라져 둘 다 고를 수 없다.
// 항목은 항상 전부 보여주고, 건수만 현재 조건에 맞춰 갈아끼운다.
const allOptions = { country: [], award: [], process: [], variety: [] };

// 응답이 순서 없이 도착해도 마지막 요청만 화면에 반영되도록 번호를 매긴다.
// 필터를 빠르게 여러 번 바꾸면 먼저 보낸 요청이 나중에 도착할 수 있다.
let latestRequestId = 0;

// ============================================================
// 요소
// ============================================================

const form = document.querySelector('[data-filters]');
const searchInput = document.querySelector('#filter-q');
const sortSelect = document.querySelector('[data-sort]');
const resetButton = document.querySelector('[data-reset]');
const countSlot = document.querySelector('[data-count]');
const gridSlot = document.querySelector('[data-lot-grid]');
const paginationSlot = document.querySelector('[data-pagination]');

// ============================================================
// 주소창 ↔ 상태
// ============================================================

// 새로고침하거나 링크를 공유해도 같은 화면이 나오도록 주소에서 상태를 복원한다.
function readStateFromUrl() {
  const params = new URLSearchParams(location.search);

  for (const key of LIST_FILTERS) {
    const raw = params.get(key);
    state[key] = raw ? [...new Set(raw.split(',').map((v) => v.trim()).filter(Boolean))] : [];
  }

  state.q = params.get('q') ?? '';

  for (const key of ['minAcidity', 'minBody', 'minSweetness']) {
    const value = Number(params.get(key));
    const bounded = Number.isFinite(value) ? Math.min(5, Math.max(0, value)) : 0;
    state[key] = Math.round(bounded * 2) / 2;
  }

  const sort = params.get('sort');
  const order = params.get('order');
  if (SORT_OPTIONS.includes(`${sort}:${order}`)) {
    state.sort = sort;
    state.order = order;
  }

  const page = Number(params.get('page'));
  state.page = Number.isInteger(page) && page > 0 ? page : 1;
}

// 서버 요청과 주소창이 공유할 사용자 상태를 만든다.
// 기본 정렬·빈 필터·1페이지는 빼서 첫 화면 주소가 /beans.html 그대로 남게 한다.
function currentParams() {
  const usesDefaultSort = state.sort === 'score' && state.order === 'desc';
  return {
    country: state.country,
    award: state.award,
    process: state.process,
    variety: state.variety,
    q: state.q.trim(),
    minAcidity: state.minAcidity || '',
    minBody: state.minBody || '',
    minSweetness: state.minSweetness || '',
    sort: usesDefaultSort ? '' : state.sort,
    order: usesDefaultSort ? '' : state.order,
    page: state.page > 1 ? state.page : ''
  };
}

// 주소만 갈아끼운다. pushState가 아니라 replaceState라 뒤로가기 기록이 쌓이지 않는다.
// 체크박스를 열 번 누르면 뒤로가기를 열 번 눌러야 하는 상황을 피하기 위해서다.
function syncUrl() {
  const query = buildQuery(currentParams());
  history.replaceState(null, '', query === '' ? location.pathname : query);
}

// ============================================================
// 그리기
// ============================================================

// 체크박스 한 줄. 옆에 현재 조건에서의 건수를 붙인다.
function renderCheckbox(group, value, label, count, checked, index) {
  // 품종명에는 공백·따옴표 등이 들어갈 수 있으므로 원문을 id로 쓰지 않는다.
  const inputId = `f-${group}-${index}`;
  const input = createEl('input', {
    attrs: { type: 'checkbox', value, id: inputId }
  });
  input.checked = checked;
  // 건수가 0이면 눌러도 결과가 없다. 이미 선택한 항목은 해제할 수 있어야 하므로 남겨 둔다.
  if (count === 0 && !checked) input.disabled = true;

  input.addEventListener('change', () => {
    state[group] = input.checked
      ? [...state[group], value]
      : state[group].filter((v) => v !== value);
    // 조건이 바뀌면 보고 있던 페이지 번호는 의미가 없다.
    state.page = 1;
    load();
  });

  const row = createEl('label', { className: 'check', attrs: { for: inputId } });
  row.append(
    input,
    createEl('span', { className: 'check__label', text: label }),
    createEl('span', { className: 'check__count num', text: formatNumber(count) })
  );
  return row;
}

// 체크박스 목록을 다시 그린다.
// 항목은 전체 목록에서, 건수는 현재 조건의 facets에서 가져온다.
// 세는 일은 전부 서버가 하고 프론트는 숫자를 옮겨 적기만 한다.
function renderFacetGroup(group, counts, labelOf) {
  const slot = document.querySelector(`[data-facet="${group}"]`);
  if (!slot) return;

  // 전체 목록 + 지금 응답에 있는 값 + 선택한 값. 셋을 합쳐야 빠지는 항목이 없다.
  const values = new Set([...allOptions[group], ...Object.keys(counts), ...state[group]]);

  // 건수 많은 순, 같으면 이름순.
  const sorted = [...values].sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0) || a.localeCompare(b));

  clearChildren(slot);
  for (const [index, value] of sorted.entries()) {
    slot.append(renderCheckbox(
      group, value, labelOf(value), counts[value] ?? 0, state[group].includes(value), index
    ));
  }
}

// 네 축의 체크박스를 한 번에 다시 그린다. 축마다 표시 이름을 만드는 방법만 다르다.
function renderFacets(facets) {
  renderFacetGroup('country', facets.country ?? {}, (v) => COUNTRY_LABELS[v] ?? v);
  renderFacetGroup('award', facets.award ?? {}, (v) => AWARD_LABELS[v] ?? v);
  renderFacetGroup('process', facets.process ?? {}, (v) => processLabels.get(v) ?? v);
  renderFacetGroup('variety', facets.variety ?? {}, (v) => v);
}

// 페이지 버튼. 현재 페이지 주변만 보여주고 양 끝은 항상 남긴다.
function renderPagination(page, totalPages) {
  clearChildren(paginationSlot);
  if (totalPages <= 1) return;

  // 새 페이지를 불러오고 결과 영역의 시작점으로 화면을 옮긴다.
  const go = (target) => {
    state.page = target;
    load();
    // 페이지를 넘기면 목록 맨 위로 올린다. 스크롤이 중간에 남아 있으면 바뀐 걸 알기 어렵다.
    document.querySelector('#results')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const addButton = (label, target, { disabled = false, current = false } = {}) => {
    const button = createEl('button', {
      className: current ? 'page-btn page-btn--current' : 'page-btn',
      text: label,
      attrs: { type: 'button', ...(current ? { 'aria-current': 'page' } : {}) }
    });
    button.disabled = disabled;
    if (!disabled && !current) button.addEventListener('click', () => go(target));
    paginationSlot.append(button);
  };

  addButton('‹', page - 1, { disabled: page === 1 });

  const numbers = new Set([1, totalPages, page, page - 1, page + 1]);
  const visible = [...numbers].filter((n) => n >= 1 && n <= totalPages).sort((a, b) => a - b);

  let previous = 0;
  for (const number of visible) {
    if (number - previous > 1) paginationSlot.append(createEl('span', { className: 'page-gap', text: '…' }));
    addButton(String(number), number, { current: number === page });
    previous = number;
  }

  addButton('›', page + 1, { disabled: page === totalPages });
}

// 서버 응답을 화면에 옮긴다. 건수·카드·페이지 버튼을 한 곳에서 갱신해 상태가 어긋나지 않게 한다.
function renderResults({ items, total, page, totalPages }) {
  countSlot.textContent = `${formatNumber(total)}건`;

  // 범위를 벗어난 페이지는 load()에서 이미 마지막 페이지로 바로잡고 다시 부른다.
  // 여기까지 items가 비어 왔다면 조건에 맞는 로트가 정말로 없는 경우다.
  if (items.length === 0) {
    clearChildren(paginationSlot);
    showEmpty(gridSlot, '조건에 맞는 로트가 없습니다. 필터를 줄여 보세요.');
    return;
  }

  clearChildren(gridSlot);
  for (const bean of items) gridSlot.append(renderLotCard(bean));
  renderPagination(page, totalPages);
}

// ============================================================
// 불러오기
// ============================================================

async function load() {
  syncUrl();

  const requestId = (latestRequestId += 1);
  showLoading(gridSlot, PAGE_SIZE);
  countSlot.textContent = '불러오는 중…';
  clearChildren(paginationSlot);

  try {
    const result = await api.get(`/beans${buildQuery({ ...currentParams(), limit: PAGE_SIZE })}`);
    // 그 사이 더 최신 요청이 나갔으면 이 응답은 버린다.
    if (requestId !== latestRequestId) return;

    // 공유 URL의 페이지가 결과 범위를 벗어나면 마지막 유효 페이지로 바로잡는다.
    if (result.total > 0 && state.page > result.totalPages) {
      state.page = result.totalPages;
      return load();
    }

    renderResults(result);
    renderFacets(result.facets ?? {});
  } catch (error) {
    if (requestId !== latestRequestId) return;
    countSlot.textContent = '불러오지 못했습니다';
    clearChildren(paginationSlot);
    // 세 번째 인자를 주면 "다시 시도" 버튼이 함께 붙는다.
    showError(gridSlot, error, () => load());
    if (!(error instanceof ApiError)) console.error(error);
  }
}

// ============================================================
// 입력 연결
// ============================================================

// 검색은 글자를 칠 때마다 보내지 않고 멈춘 뒤 300ms 지나서 한 번만 보낸다.
function bindSearch() {
  let timer = null;

  searchInput.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.q = searchInput.value;
      state.page = 1;
      load();
    }, SEARCH_DEBOUNCE_MS);
  });

  // 엔터로는 기다리지 않고 바로 보낸다. 폼 제출로 새로고침되는 것도 함께 막는다.
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    clearTimeout(timer);
    state.q = searchInput.value;
    state.page = 1;
    load();
  });
}

// 슬라이더는 끄는 동안 숫자만 갱신하고, 손을 뗐을 때 요청을 보낸다.
function bindRanges() {
  for (const key of ['minAcidity', 'minBody', 'minSweetness']) {
    const input = form.querySelector(`[name="${key}"]`);
    const output = document.querySelector(`[data-output="${key}"]`);
    if (!input || !output) continue;

    input.addEventListener('input', () => {
      output.textContent = input.value;
    });

    input.addEventListener('change', () => {
      state[key] = Number(input.value);
      state.page = 1;
      load();
    });
  }
}

// 정렬 선택은 'sort:order' 한 문자열이라 나눠서 상태에 넣는다.
function bindSort() {
  sortSelect.addEventListener('change', () => {
    const [sort, order] = sortSelect.value.split(':');
    state.sort = sort;
    state.order = order;
    state.page = 1;
    load();
  });
}

// 전체 해제. 정렬은 그대로 두는데, 보기 순서는 필터가 아니라 사용자가 정한 취향이기 때문이다.
function bindReset() {
  resetButton.addEventListener('click', () => {
    for (const key of LIST_FILTERS) state[key] = [];
    state.q = '';
    state.minAcidity = 0;
    state.minBody = 0;
    state.minSweetness = 0;
    state.page = 1;
    syncControlsFromState();
    load();
  });
}

// 상태를 화면 컨트롤에 반영한다. 주소로 들어온 값을 되살릴 때와 전체 해제할 때 쓴다.
// (체크박스는 facets 응답으로 다시 그려지므로 여기서는 건드리지 않는다)
function syncControlsFromState() {
  searchInput.value = state.q;
  sortSelect.value = `${state.sort}:${state.order}`;

  for (const key of ['minAcidity', 'minBody', 'minSweetness']) {
    const input = form.querySelector(`[name="${key}"]`);
    const output = document.querySelector(`[data-output="${key}"]`);
    if (input) input.value = String(state[key]);
    if (output) output.textContent = String(state[key]);
  }
}

// 가공방식 체크박스에 한글 이름을 쓰기 위해 마스터를 한 번 받아 둔다.
async function loadProcessLabels() {
  try {
    for (const process of await api.get('/processes')) {
      processLabels.set(process.key, process.name_ko);
    }
  } catch {
    // 이름을 못 받아도 key를 그대로 보여주면 되므로 목록 조회를 막지 않는다.
  }
}

// 조건 없는 응답에서 전체 옵션 목록을 한 번만 받아 둔다.
// 공유 링크로 필터가 걸린 채 들어와도 체크박스에는 모든 항목이 나와야 하므로,
// 첫 조회 결과를 쓰지 않고 조건 없는 요청을 따로 한 번 보낸다. (limit=1이라 가볍다)
async function loadAllOptions() {
  try {
    const { facets } = await api.get('/beans?limit=1');
    for (const group of LIST_FILTERS) {
      allOptions[group] = Object.keys(facets?.[group] ?? {});
    }
  } catch {
    // 실패하면 facets 응답에 있는 항목만 보여준다. 목록 조회 자체는 계속 진행한다.
  }
}

// ============================================================
// 시작
// ============================================================

await layoutReady;

readStateFromUrl();
syncControlsFromState();
bindSearch();
bindRanges();
bindSort();
bindReset();

// 보조 옵션 요청을 기다리는 동안에도 결과 영역의 로딩 상태를 즉시 보여준다.
showLoading(gridSlot, PAGE_SIZE);

// 두 요청은 서로 무관해 동시에 보낸다. 둘 다 목록 조회 전에 끝나 있어야 라벨과 항목이 채워진다.
await Promise.all([loadProcessLabels(), loadAllOptions()]);
await load();
