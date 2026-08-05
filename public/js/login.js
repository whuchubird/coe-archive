// login.html — 로그인과 회원가입을 탭으로 나눈 한 페이지.
//
// 검증은 두 겹이다.
//   1) 보내기 전에 프론트에서 간단히 거른다 — 빈 칸·길이·비밀번호 확인.
//   2) 진짜 판정은 서버가 한다 — 아이디 중복, 비밀번호 대조, 시도 횟수 제한.
// 서버가 돌려준 문구는 손대지 않고 그대로 보여준다. 프론트가 다시 쓰면
// "이미 사용 중인 아이디입니다" 같은 실제 원인이 뭉개진다.
import { layoutReady, api, ApiError, getCurrentUser } from './common.js';

const USERNAME_MIN = 3;
const USERNAME_MAX = 20;
const PASSWORD_MIN = 8;

const tabs = [...document.querySelectorAll('[role="tab"]')];
const panels = new Map(tabs.map((tab) => [tab, document.querySelector(`#${tab.getAttribute('aria-controls')}`)]));

// ============================================================
// 로그인 후 돌아갈 곳
// ============================================================

// requireLogin()이 ?next=/notes.html 처럼 붙여 보낸다.
// 다른 사이트 주소가 들어오면 그대로 보내지 않는다 — 열린 리다이렉트가 된다.
// 같은 사이트 안의 경로(/로 시작하고 //가 아닌 것)만 허용한다.
function safeNextPath() {
  const raw = new URLSearchParams(location.search).get('next');
  if (!raw) return '/index.html';
  try {
    const target = new URL(raw, location.origin);
    if (target.origin !== location.origin) return '/index.html';
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return '/index.html';
  }
}

// ============================================================
// 탭 전환
// ============================================================

function selectTab(target) {
  for (const tab of tabs) {
    const selected = tab === target;
    tab.setAttribute('aria-selected', String(selected));
    // 선택된 탭만 Tab 키 순서에 남긴다. 나머지는 좌우 화살표로 이동한다.
    tab.tabIndex = selected ? 0 : -1;
    panels.get(tab).hidden = !selected;
  }
  target.focus();
}

for (const [index, tab] of tabs.entries()) {
  tab.addEventListener('click', () => selectTab(tab));

  // 탭 목록의 표준 키 조작. 좌우로 이동하고 양 끝에서 돌아온다.
  tab.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const step = event.key === 'ArrowRight' ? 1 : -1;
    selectTab(tabs[(index + step + tabs.length) % tabs.length]);
  });
}

// ============================================================
// 에러 표시
// ============================================================

function showFormError(form, message) {
  const slot = document.querySelector(`[data-error="${form}"]`);
  slot.textContent = message;
  slot.hidden = message === '';
}

// 에러 자리를 비운다. 새로 제출할 때마다 이전 문구를 먼저 지운다.
function clearFormError(form) {
  showFormError(form, '');
}

// 서버가 준 문구를 그대로 쓴다. ApiError가 아니면(네트워크 등) 일반 문구로 대체한다.
function messageFrom(error) {
  return error instanceof ApiError ? error.message : '요청을 보내지 못했습니다. 잠시 후 다시 시도해 주세요.';
}

// ============================================================
// 제출
// ============================================================

// 제출 중에는 버튼을 잠가 같은 요청이 두 번 나가지 않게 한다.
async function withSubmitting(form, run) {
  const button = form.querySelector('button[type="submit"]');
  const label = button.textContent;
  button.disabled = true;
  button.textContent = '처리 중…';
  try {
    await run();
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

const loginForm = document.querySelector('[data-form="login"]');
const registerForm = document.querySelector('[data-form="register"]');

loginForm.addEventListener('submit', (event) => {
  event.preventDefault();
  clearFormError('login');

  const username = loginForm.username.value.trim();
  const password = loginForm.password.value;

  if (username === '' || password === '') {
    return showFormError('login', '아이디와 비밀번호를 모두 입력해 주세요.');
  }

  withSubmitting(loginForm, async () => {
    try {
      await api.post('/auth/login', { username, password });
      // 헤더를 먼저 갱신할 필요는 없다. 이동하면 새로 그려진다.
      location.href = safeNextPath();
    } catch (error) {
      showFormError('login', messageFrom(error));
    }
  });
});

registerForm.addEventListener('submit', (event) => {
  event.preventDefault();
  clearFormError('register');

  const username = registerForm.username.value.trim();
  const password = registerForm.password.value;
  const confirm = registerForm.confirm.value;

  // 서버에 보내기 전에 확실히 걸러낼 수 있는 것만 여기서 막는다.
  if (username.length < USERNAME_MIN || username.length > USERNAME_MAX) {
    return showFormError('register', `아이디는 ${USERNAME_MIN}~${USERNAME_MAX}자로 입력해 주세요.`);
  }
  if (password.length < PASSWORD_MIN) {
    return showFormError('register', `비밀번호는 ${PASSWORD_MIN}자 이상이어야 합니다.`);
  }
  // 비밀번호 확인은 서버가 알 수 없는 값이라 프론트에서만 검사한다.
  if (password !== confirm) {
    return showFormError('register', '비밀번호가 서로 다릅니다.');
  }

  withSubmitting(registerForm, async () => {
    try {
      // 아이디 중복은 서버의 유일 제약이 판정한다. 이미 있으면 409와 함께 문구가 온다.
      await api.post('/auth/register', { username, password });
      // 가입하면 바로 로그인 상태가 되므로 그대로 이동한다.
      location.href = safeNextPath();
    } catch (error) {
      showFormError('register', messageFrom(error));
    }
  });
});

// ============================================================
// 시작
// ============================================================

await layoutReady;

// 이미 로그인한 사람이 주소를 직접 쳐서 들어온 경우.
// 강제로 튕겨내지 않고 상태만 알린다 — 다른 계정으로 바꿔 로그인할 수도 있다.
if (getCurrentUser()) {
  const notice = document.querySelector('[data-already]');
  notice.textContent = `${getCurrentUser().username} 님으로 로그인되어 있습니다.`;
  notice.hidden = false;
}

// ?next=가 있으면 어디로 돌아갈지 알려 준다.
const next = safeNextPath();
if (next !== '/index.html') {
  const hint = document.createElement('p');
  hint.className = 'muted';
  hint.textContent = `로그인하면 ${next} 로 돌아갑니다.`;
  document.querySelector('.tabs').before(hint);
}
