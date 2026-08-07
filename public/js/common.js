// 모든 페이지가 공통으로 쓰는 동작.
// 헤더 갱신·다크 모드·숫자 포맷·로딩과 에러 표시를 담당한다.
// 페이지별 스크립트는 이 파일에서 필요한 것만 가져다 쓴다.
import { api, ApiError, buildQuery } from './api.js';

// ============================================================
// 다크 모드
// ============================================================

const THEME_KEY = 'coe-theme';

// html 요소의 data-theme만 바꾼다. 색은 CSS 변수가 알아서 교환된다.
export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const button = document.querySelector('[data-theme-toggle]');
  if (!button) return;
  button.textContent = theme === 'dark' ? '☀' : '☾';
  button.setAttribute('aria-label', theme === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환');
}

// 현재 모드를 뒤집고 선택을 저장한다. 다음 방문에도 유지된다.
export function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  // 저장소 접근이 막힌 환경에서도 현재 페이지의 모드 전환은 동작해야 한다.
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // 저장만 생략하고 아래에서 테마는 정상 적용한다.
  }
  applyTheme(next);
}

// 테마 버튼 표시를 현재 모드에 맞추고 클릭을 연결한다.
function initTheme() {
  // 초기 모드는 <head>의 인라인 스크립트가 이미 정해 뒀다(화면 깜빡임 방지).
  // 인라인 스크립트가 없는 페이지에서도 시스템 설정을 기본값으로 쓴다.
  const current = document.documentElement.dataset.theme;
  const fallback = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  applyTheme(current === 'dark' || current === 'light' ? current : fallback);
  document.querySelector('[data-theme-toggle]')?.addEventListener('click', toggleTheme);
}

// ============================================================
// 로그인 상태
// ============================================================

let currentUser = null;

// 페이지 스크립트가 로그인 여부를 물어볼 때 쓴다. 로그인 전이면 null이다.
export function getCurrentUser() {
  return currentUser;
}

// 서버에 로그인 상태를 물어 헤더를 갱신한다.
// body의 data-auth 값만 바꾸면 CSS가 메뉴를 보이고 숨긴다.
export async function refreshAuth() {
  try {
    const result = await api.get('/auth/me');
    currentUser = result.authenticated ? result.user : null;
  } catch {
    // 상태 확인에 실패해도 페이지 전체를 막지 않는다. 비로그인으로 간주한다.
    currentUser = null;
  }

  document.body.dataset.auth = currentUser ? 'member' : 'guest';
  // 권한은 로그인 여부와 별개다. 메뉴를 보이고 숨기는 데만 쓰고,
  // 실제 접근 판정은 서버의 requireAdmin이 한다.
  document.body.dataset.role = currentUser?.role ?? 'guest';

  const nameSlot = document.querySelector('[data-user-name]');
  // 사용자가 정한 값이므로 innerHTML이 아니라 textContent로 넣는다.
  if (nameSlot) nameSlot.textContent = currentUser ? currentUser.username : '';

  syncAdminNav();

  return currentUser;
}

// 관리자에게만 헤더에 '관리' 메뉴를 붙인다.
//
// 메뉴를 숨기는 것은 편의일 뿐 보안이 아니다. 주소를 직접 쳐서 들어와도
// admin.html이 다시 확인하고, 무엇보다 /api/admin/* 이 매 요청 권한을 본다.
// 여기서 만들어 넣는 이유는 페이지마다 같은 <li>를 적어 두면 관리자가 아닌
// 사람의 HTML에도 관리 화면의 존재가 그대로 드러나기 때문이다.
function syncAdminNav() {
  const nav = document.querySelector('.nav');
  if (!nav) return;

  const existing = nav.querySelector('[data-admin-nav]');

  if (currentUser?.role !== 'admin') {
    existing?.remove();
    return;
  }
  if (existing) return;

  const link = createEl('a', { className: 'nav__link', text: '관리', attrs: { href: '/admin.html' } });
  if (location.pathname === '/admin.html') link.setAttribute('aria-current', 'page');

  const item = createEl('li', { className: 'admin-only', children: [link] });
  item.dataset.adminNav = '';

  // 사용자 이름·로그아웃 앞에 둔다. 그 둘은 항상 오른쪽 끝에 있어야 한다.
  const nameItem = nav.querySelector('[data-user-name]')?.closest('li');
  nav.insertBefore(item, nameItem ?? null);
}

// 헤더의 로그아웃 버튼을 연결한다. 실패하더라도 첫 화면으로는 보낸다.
function initLogout() {
  document.querySelector('[data-logout]')?.addEventListener('click', async (event) => {
    event.preventDefault();
    try {
      await api.post('/auth/logout');
    } finally {
      // 로그아웃 후에는 어디에 있든 첫 화면으로 보낸다.
      location.href = '/index.html';
    }
  });
}

// 로그인이 필요한 페이지(notes.html)에서 맨 앞에 호출한다.
// 비로그인이면 로그인 페이지로 보내고 false를 돌려준다.
export function requireLogin() {
  if (currentUser) return true;
  const next = encodeURIComponent(location.pathname + location.search);
  location.replace(`/login.html?next=${next}`);
  return false;
}

// ============================================================
// 네비게이션
// ============================================================

// 지금 보고 있는 페이지의 메뉴에 표시를 남긴다.
// aria-current는 스크린리더에도 현재 위치를 알려주고, CSS 선택자로도 그대로 쓴다.
function markCurrentNav() {
  const here = location.pathname.replace(/\/$/, '/index.html');
  for (const link of document.querySelectorAll('.nav__link')) {
    const path = new URL(link.href, location.origin).pathname;
    if (path === here) link.setAttribute('aria-current', 'page');
  }
}

// ============================================================
// 숫자·통화 포맷
// ============================================================

// 값이 없을 때 화면에 남길 기호. 0과 구분되어야 한다.
const EMPTY = '—';

const usdFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

const numberFormatter = new Intl.NumberFormat('ko-KR');

// 화면에 숫자로 쓸 수 없는 값인지 판단한다. 0과 빈 값을 구분하기 위해 따로 둔다.
function isMissing(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string' && value.trim() === '') return true;
  return !Number.isFinite(Number(value));
}

// 커핑 점수. 소수점 둘째 자리까지 고정해 자릿수를 맞춘다.
export function formatScore(value) {
  return isMissing(value) ? EMPTY : Number(value).toFixed(2);
}

// 낙찰가·총액. $61.40 형태.
export function formatUsd(value) {
  return isMissing(value) ? EMPTY : usdFormatter.format(Number(value));
}

// 파운드 단위 중량.
export function formatWeight(value) {
  return isMissing(value) ? EMPTY : `${numberFormatter.format(Number(value))} lb`;
}

// 건수 등 일반 숫자. 천 단위 구분.
export function formatNumber(value) {
  return isMissing(value) ? EMPTY : numberFormatter.format(Number(value));
}

// 감각 6축·별점처럼 소수 한 자리로 보여줄 값.
export function formatDecimal(value, digits = 1) {
  return isMissing(value) ? EMPTY : Number(value).toFixed(digits);
}

// 노트 작성 시각.
export function formatDate(value) {
  if (!value) return EMPTY;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? EMPTY
    : date.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
}

// 순위. NW 로트는 순위가 없어 등급 약어를 대신 보여준다.
export function formatRank(rank, award) {
  return rank === null || rank === undefined ? (award ?? EMPTY) : String(rank);
}

// ============================================================
// DOM 유틸
// ============================================================

export function clearChildren(target) {
  while (target.firstChild) target.removeChild(target.firstChild);
}

// 요소를 만들어 돌려준다. 텍스트는 항상 textContent로 넣어 HTML이 실행되지 않게 한다.
export function createEl(tag, { className, text, attrs, children } = {}) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value !== undefined && value !== null) element.setAttribute(key, String(value));
    }
  }
  if (children) {
    for (const child of children) {
      if (child) element.append(child);
    }
  }
  return element;
}

// ============================================================
// 로트 전표 카드
// ============================================================

// 카드 하나를 만들어 돌려준다.
// index·beans·detail(유사 로트)·notes가 같은 모양을 쓰므로 공통 파일에 둔다.
// 제목 태그는 페이지의 제목 단계에 맞출 수 있게 인자로 받는다.
export function renderLotCard(bean, { headingTag = 'h3' } = {}) {
  const card = createEl('a', {
    className: 'lot',
    attrs: { href: `/detail.html?id=${encodeURIComponent(bean.id)}` }
  });

  // NW 로트는 순위가 없어 도장 자리에 등급 약어를 넣고 색을 죽인다.
  const isNationalWinner = bean.rank === null || bean.rank === undefined;

  const head = createEl('div', {
    className: 'lot__head',
    children: [
      createEl('div', {
        className: isNationalWinner ? 'lot__rank lot__rank--nw' : 'lot__rank',
        text: formatRank(bean.rank, bean.award)
      }),
      createEl('div', {
        children: [
          createEl(headingTag, { className: 'lot__title', text: bean.farm }),
          createEl('p', {
            className: 'lot__origin',
            text: [bean.country_ko, bean.region].filter(Boolean).join(' · ')
          })
        ]
      })
    ]
  });

  const bid = createEl('span', { className: 'lot__bid' });
  bid.append(
    document.createTextNode(formatUsd(bean.bid_per_lb)),
    createEl('small', { text: ' /lb' })
  );

  const figures = createEl('div', {
    className: 'lot__figures',
    children: [createEl('span', { className: 'lot__score', text: formatScore(bean.score) }), bid]
  });

  const foot = createEl('div', {
    className: 'lot__foot',
    children: [
      createEl('span', { className: 'lot__id', text: bean.id }),
      createEl('span', { className: 'lot__process', text: bean.process_name_ko ?? '' }),
      bean.has_korean_buyer ? createEl('span', { className: 'lot__korean', text: '한국 낙찰' }) : null
    ]
  });

  card.append(head, figures, createEl('hr', { className: 'lot__tear' }), foot);
  return card;
}

// ============================================================
// 로딩·에러·빈 상태
// ============================================================

// 내용이 들어올 자리에 회색 상자를 깔아 화면이 갑자기 늘어나지 않게 한다.
export function showLoading(target, count = 3) {
  clearChildren(target);

  // 대상이 이미 그리드면 래퍼를 새로 만들지 않는다.
  // 그리드 안에 그리드를 넣으면 스켈레톤이 한 칸에 세로로 쌓여 실제 카드 배치와 달라진다.
  const isGrid = target.classList?.contains('grid') === true;
  const holder = isGrid ? target : createEl('div', { className: 'grid' });

  for (let i = 0; i < count; i += 1) {
    holder.append(createEl('div', { className: 'skeleton', attrs: { 'aria-hidden': 'true' } }));
  }

  // .visually-hidden은 position:absolute라 그리드 칸을 차지하지 않는다.
  const notice = createEl('p', { className: 'visually-hidden', text: '불러오는 중입니다.' });
  if (isGrid) target.prepend(notice);
  else target.append(notice, holder);
}

// 실패를 사용자 말로 보여준다. ApiError면 서버가 준 메시지를 그대로 쓴다.
// onRetry를 넘기면 "다시 시도" 버튼을 함께 붙인다. 네트워크가 잠깐 끊긴 경우
// 새로고침 없이 같은 요청을 다시 보낼 수 있어야 하기 때문이다.
export function showError(target, error, onRetry) {
  const message = error instanceof ApiError ? error.message : '알 수 없는 오류가 발생했습니다.';
  clearChildren(target);

  const box = createEl('div', {
    className: 'state state--error',
    attrs: { role: 'alert' }
  });
  box.append(createEl('p', { text: message }));

  if (onRetry) {
    const button = createEl('button', {
      className: 'btn btn--sm',
      text: '다시 시도',
      attrs: { type: 'button' }
    });
    button.addEventListener('click', onRetry);
    box.append(button);
  }

  target.append(box);
}

// 조건에 맞는 결과가 없을 때. 오류와 구분되어야 한다.
export function showEmpty(target, message = '표시할 항목이 없습니다.') {
  clearChildren(target);
  target.append(createEl('p', { className: 'state', text: message }));
}

// ============================================================
// 움직임
// ============================================================
//
// 이 사이트의 성격은 경매 전표와 커핑 점수표다. 시선을 끄는 움직임이 아니라
// "값이 채워지는 과정"만 짧게 보여주고 멈춘다. 튕기거나 흔들리는 것은 쓰지 않는다.

// 움직임을 줄여 달라고 설정한 사용자인지 확인한다.
// 이 경우 애니메이션을 건너뛰고 최종 상태를 바로 보여준다 — 값은 똑같이 다 보인다.
export function prefersReducedMotion() {
  // matchMedia가 없는 환경에서 예외가 나면 차트 그리기 자체가 멈춘다.
  // 설정을 알 수 없을 뿐이므로 '줄이지 않음'으로 보고 넘어간다.
  if (typeof matchMedia !== 'function') return false;
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// 특정 영역의 머리로 화면을 옮긴다.
//
// scrollIntoView는 옵션으로 넘긴 behavior가 CSS의 scroll-behavior보다 우선한다.
// 그래서 'smooth'를 그대로 두면 움직임을 줄여 달라고 설정해도 화면이 미끄러진다.
// 어느 쪽이든 이동은 똑같이 일어나고, 그 과정을 보여줄지만 달라진다.
export function scrollToStart(element) {
  element?.scrollIntoView({
    behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    block: 'start'
  });
}

// 요소가 화면에 들어오면 한 번만 실행한다.
//
// 화면 밖에서 애니메이션이 끝나 버리면 사용자는 결과만 보게 되어 효과가 없다.
// IntersectionObserver가 없는 환경(구형 브라우저·검증용 스텁)에서는 바로 실행한다.
export function onceInView(element, run, { threshold = 0.35 } = {}) {
  if (typeof IntersectionObserver !== 'function') return run();

  // 한 번의 콜백에 여러 entry가 함께 오기도 한다. 깃발을 따로 두어야 정말 한 번만 돈다.
  let done = false;
  const observer = new IntersectionObserver((entries) => {
    if (done) return;
    if (!entries.some((entry) => entry.isIntersecting)) return;
    done = true;
    observer.disconnect();
    run();
  }, { threshold });

  observer.observe(element);
}

// 0에서 목표값까지 숫자를 올린다.
//
// format을 받는 이유는 화면에 나갈 문자열이 '74건', '$143.10 /lb'처럼
// 숫자 말고도 붙는 것이 있어서다. 중간값도 같은 함수로 만들어야 자릿수가 흔들리지 않는다.
// (숫자 칸은 tabular-nums라 폭도 고정된다)
// 다른 움직임은 200ms지만 이것만 길다.
// 전환은 '바뀌었다'만 알리면 되지만, 카운트업은 올라가는 과정 자체가 보여줄 내용이다.
// 200ms면 숫자가 도는 것이 보이지 않아 기능이 없는 것과 같아진다.
export function countUp(element, target, format, { duration = 900 } = {}) {
  // 값이 없는 지표는 손대지 않는다.
  // Number(null)은 0이라, 여기서 걸러내지 않으면 '자료 없음'이 '0'으로 둔갑한다.
  if (target === null || target === undefined || target === '') return;

  const end = Number(target);
  if (!Number.isFinite(end)) return;

  // 최종값을 먼저 넣어 둔다. 움직임을 건너뛰더라도 화면에는 항상 제 값이 남는다.
  element.textContent = format(end);
  if (prefersReducedMotion()) return;

  const started = performance.now();
  const step = (now) => {
    const progress = Math.min(1, (now - started) / duration);
    // 끝에서 부드럽게 멎는 곡선. 되돌아오거나 넘어가지 않는다.
    const eased = 1 - (1 - progress) ** 3;
    element.textContent = format(end * eased);
    if (progress < 1) requestAnimationFrame(step);
    else element.textContent = format(end);
  };
  requestAnimationFrame(step);
}

// ============================================================
// 초기화
// ============================================================

// 모든 페이지에서 공통으로 필요한 준비. 모듈이 defer로 실행되므로 DOM은 이미 있다.
async function initLayout() {
  initTheme();
  initLogout();
  markCurrentNav();
  await refreshAuth();
}

// 페이지 스크립트가 `await layoutReady`로 로그인 상태 확인이 끝날 때까지 기다릴 수 있다.
export const layoutReady = initLayout();

// 페이지 스크립트가 common.js 하나만 보고도 API를 쓸 수 있도록 그대로 다시 내보낸다.
export { api, ApiError, buildQuery };
