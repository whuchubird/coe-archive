// admin.html — 관리자 화면.
//
// 여기서 하는 권한 확인은 화면을 정리하기 위한 것이지 보안 장치가 아니다.
// 주소를 직접 쳐서 들어오든 이 검사를 지우든, 실제 판정은 서버의 requireAdmin이 한다.
// 이 파일이 없어도 /api/admin/* 은 관리자가 아닌 요청에 403을 돌려준다.
import {
  api, ApiError, layoutReady, buildQuery,
  createEl, clearChildren, showError, showEmpty, showLoading,
  formatScore, formatUsd, formatNumber, formatDate, formatRank
} from './common.js';

const SENSORY_AXES = [
  { key: 'aroma', label: '향' },
  { key: 'acidity', label: '산미' },
  { key: 'body', label: '바디' },
  { key: 'sweetness', label: '단맛' },
  { key: 'aftertaste', label: '후미' },
  { key: 'balance', label: '밸런스' }
];

// 목록·폼이 함께 보는 상태. 페이지 하나에 탭이 셋이라 한곳에 모아 둔다.
const state = {
  me: null,
  processes: [],
  beans: [],
  users: [],
  search: '',
  sort: 'id',
  order: 'asc',
  processError: null,
  // 폼이 수정 중인 로트 ID. null이면 추가다.
  editingId: null,
  deletingId: null,
  deletingUserId: null
};

const $ = (selector) => document.querySelector(selector);

const el = {
  checking: $('[data-admin-checking]'),
  denied: $('[data-admin-denied]'),
  app: $('[data-admin-app]'),

  totals: $('[data-admin-totals]'),
  recentUsers: $('[data-recent-users]'),
  recentNotes: $('[data-recent-notes]'),

  beanSearch: $('[data-bean-search]'),
  beanSort: $('[data-bean-sort]'),
  beanCount: $('[data-bean-count]'),
  beanAdd: $('[data-bean-add]'),
  beanRows: $('[data-bean-rows]'),
  beanState: $('[data-bean-state]'),
  beanTableWrap: $('[data-bean-table-wrap]'),

  userRows: $('[data-user-rows]'),
  userState: $('[data-user-state]'),

  beanDialog: $('[data-bean-dialog]'),
  beanForm: $('[data-bean-form]'),
  beanError: $('[data-bean-error]'),
  beanSubmit: $('[data-bean-submit]'),
  beanCancel: $('[data-bean-cancel]'),
  dialogTitle: $('#bean-dialog-title'),
  processSelect: $('[data-process-select]'),
  axisGrid: $('[data-axis-grid]'),
  preview: $('[data-preview]'),

  deleteDialog: $('[data-delete-dialog]'),
  deleteTarget: $('[data-delete-target]'),
  deleteError: $('[data-delete-error]'),
  deleteConfirm: $('[data-delete-confirm]'),
  deleteCancel: $('[data-delete-cancel]'),

  userDeleteDialog: $('[data-user-delete-dialog]'),
  userDeleteTarget: $('[data-user-delete-target]'),
  userDeleteImpact: $('[data-user-delete-impact]'),
  userDeleteError: $('[data-user-delete-error]'),
  userDeleteConfirm: $('[data-user-delete-confirm]'),
  userDeleteCancel: $('[data-user-delete-cancel]')
};

// ============================================================
// 공통
// ============================================================

// 서버가 준 문구를 그대로 보여준다. 화면이 문구를 지어내면 원인을 알 수 없다.
function showFormError(slot, message) {
  slot.textContent = message;
  slot.hidden = false;
}

// 다시 시도하기 전에 앞선 오류 문구를 지운다. 남아 있으면 방금 실패한 것처럼 보인다.
function clearFormError(slot) {
  slot.textContent = '';
  slot.hidden = true;
}

// 쉼표 입력을 서버와 같은 규칙으로 나눈다.
// 미리보기가 실제 저장 결과와 어긋나지 않도록 서버의 parseNameList와 맞춘다.
function splitNames(raw) {
  const seen = new Map();
  for (const part of String(raw ?? '').split(',')) {
    const name = part.trim();
    if (name === '') continue;
    const key = name.toLowerCase();
    if (!seen.has(key)) seen.set(key, name);
  }
  return [...seen.values()];
}

// 빈 문자열은 null로 보낸다. 서버가 '값 없음'과 0을 구분할 수 있어야 한다.
function emptyToNull(value) {
  const trimmed = String(value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

// ============================================================
// 접근 제어
// ============================================================

// 로그인 상태와 권한을 확인해 화면을 셋 중 하나로 정한다.
// 관리자가 아니면 안내를 띄우고 잠시 뒤 메인으로 보낸다.
async function gate() {
  el.checking.hidden = false;
  el.denied.hidden = true;
  el.app.hidden = true;

  try {
    // common.js의 헤더 확인과 별개로 이 페이지가 직접 다시 확인한다.
    // 네트워크 실패를 권한 없음으로 오인해 메인으로 보내지 않기 위해서다.
    const result = await api.get('/auth/me');
    state.me = result.authenticated ? result.user : null;
  } catch (err) {
    showError(el.checking, err, init);
    return false;
  }

  el.checking.hidden = true;
  if (state.me?.role === 'admin') {
    el.app.hidden = false;
    return true;
  }

  el.denied.hidden = false;
  // 바로 튕기면 왜 돌아왔는지 알 수 없어, 문구를 읽을 시간을 준다.
  setTimeout(() => location.replace('/index.html'), 2500);
  return false;
}

// ============================================================
// 탭
// ============================================================

// 탭 전환. 선택된 버튼만 tabindex 0을 갖게 해 Tab 한 번으로 탭 묶음을 지나가게 한다.
function initTabs() {
  const tabs = [...document.querySelectorAll('[role="tab"]')];

  // 탭을 열 때마다 그 탭의 목록을 다시 받는다.
  // 특히 사용자 표의 노트·즐겨찾기 수는 계정 삭제 모달이 "무엇이 함께 사라지는지"를
  // 알리는 근거라, 오래된 숫자를 보여주면 안 된다.
  const refresh = {
    'tab-dashboard': loadSummary,
    'tab-beans': loadBeans,
    'tab-users': loadUsers
  };

  const select = (target) => {
    for (const tab of tabs) {
      const on = tab === target;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      document.getElementById(tab.getAttribute('aria-controls')).hidden = !on;
    }
    target.focus();
    refresh[target.id]?.();
  };

  for (const tab of tabs) {
    tab.addEventListener('click', () => select(tab));
    // 좌우 화살표로 탭을 옮기는 것은 탭 위젯의 기본 동작이다.
    tab.addEventListener('keydown', (event) => {
      const step = { ArrowRight: 1, ArrowLeft: -1, Home: -Infinity, End: Infinity }[event.key];
      if (step === undefined) return;
      event.preventDefault();
      const index = tabs.indexOf(tab);
      const next = step === -Infinity ? 0
        : step === Infinity ? tabs.length - 1
          : (index + step + tabs.length) % tabs.length;
      select(tabs[next]);
    });
  }
}

// ============================================================
// 대시보드
// ============================================================

// 총계와 최근 활동을 불러 표에 채운다.
async function loadSummary() {
  showLoading(el.totals, 1);
  try {
    const summary = await api.get('/admin/summary');
    renderTotals(summary.totals);
    renderRecentUsers(summary.recentUsers);
    renderRecentNotes(summary.recentNotes);
  } catch (err) {
    showError(el.totals, err, loadSummary);
  }
}

// 총계를 정의 목록으로 그린다. 숫자가 주인공이라 값이 크게 온다.
function renderTotals(totals) {
  clearChildren(el.totals);
  const items = [
    ['로트', totals.beans],
    ['사용자', totals.users],
    ['관리자', totals.admins],
    ['노트', totals.notes],
    ['즐겨찾기', totals.favorites]
  ];
  for (const [label, value] of items) {
    const box = createEl('div', { className: 'admin-total' });
    box.append(
      createEl('dt', { className: 'admin-total__label', text: label }),
      createEl('dd', { className: 'admin-total__value num', text: formatNumber(value) })
    );
    el.totals.append(box);
  }
}

// 최근 가입 5명.
function renderRecentUsers(users) {
  clearChildren(el.recentUsers);
  if (users.length === 0) {
    el.recentUsers.append(emptyRow(3, '가입한 사용자가 없습니다.'));
    return;
  }
  for (const user of users) {
    const row = createEl('tr');
    row.append(
      createEl('th', { text: user.username, attrs: { scope: 'row' } }),
      createEl('td', { children: [roleBadge(user.role)] }),
      createEl('td', { className: 'num', text: formatDate(user.created_at) })
    );
    el.recentUsers.append(row);
  }
}

// 최근 노트 5건.
function renderRecentNotes(notes) {
  clearChildren(el.recentNotes);
  if (notes.length === 0) {
    el.recentNotes.append(emptyRow(4, '작성된 노트가 없습니다.'));
    return;
  }
  for (const note of notes) {
    const row = createEl('tr');
    const lot = createEl('td');
    lot.append(createEl('a', {
      className: 'link',
      text: note.farm,
      attrs: { href: `/detail.html?id=${encodeURIComponent(note.bean_id)}` }
    }));
    row.append(
      createEl('th', { text: note.username, attrs: { scope: 'row' } }),
      lot,
      createEl('td', { className: 'num', text: note.rating === null ? '—' : `${note.rating}점` }),
      createEl('td', { className: 'num', text: formatDate(note.created_at) })
    );
    el.recentNotes.append(row);
  }
}

// 표 안의 '없음' 한 줄.
function emptyRow(span, message) {
  const row = createEl('tr');
  row.append(createEl('td', { className: 'muted', text: message, attrs: { colspan: String(span) } }));
  return row;
}

// 권한을 한눈에 구분되게 표시한다.
function roleBadge(role) {
  return createEl('span', {
    className: role === 'admin' ? 'badge badge--admin' : 'badge',
    text: role === 'admin' ? '관리자' : '일반'
  });
}

// ============================================================
// 로트 관리
// ============================================================

// 현재 검색·정렬 조건으로 목록을 다시 받는다.
async function loadBeans() {
  clearChildren(el.beanState);
  el.beanTableWrap.hidden = true;
  showLoading(el.beanState, 4);

  try {
    const query = buildQuery({ q: state.search, sort: state.sort, order: state.order });
    state.beans = await api.get(`/admin/beans${query}`);
    clearChildren(el.beanState);
    renderBeanRows();
  } catch (err) {
    clearChildren(el.beanState);
    showError(el.beanState, err, loadBeans);
  }
}

// 목록을 표로 그린다. 카드보다 표가 낫다 — 한 화면에 더 많이 들어오고
// 점수·낙찰가·노트 수를 세로로 비교할 수 있다.
function renderBeanRows() {
  clearChildren(el.beanRows);
  el.beanCount.textContent = `${formatNumber(state.beans.length)}건`;

  if (state.beans.length === 0) {
    el.beanTableWrap.hidden = true;
    showEmpty(el.beanState, '조건에 맞는 로트가 없습니다.');
    return;
  }
  el.beanTableWrap.hidden = false;

  for (const bean of state.beans) {
    const row = createEl('tr');
    row.dataset.beanId = bean.id;

    const idCell = createEl('th', { attrs: { scope: 'row' } });
    idCell.append(createEl('span', { className: 'mono', text: bean.id }));

    const farmCell = createEl('td', { text: bean.farm });
    // NW 로트는 순위가 없으므로 등급만 남긴다.
    const rankText = bean.rank === null || bean.rank === undefined
      ? bean.award
      : `${bean.award} ${formatRank(bean.rank, bean.award)}위`;
    farmCell.append(createEl('span', { className: 'admin-rank muted', text: ` ${rankText}` }));

    const noteCell = createEl('td', { className: 'num', text: formatNumber(bean.note_count) });
    if (bean.note_count > 0) noteCell.classList.add('admin-locked');

    const actions = createEl('div', { className: 'admin-actions' });
    actions.append(
      createEl('button', {
        className: 'btn btn--sm btn--ghost',
        text: '수정',
        attrs: { type: 'button', 'data-action': 'edit', 'aria-label': `${bean.id} 수정` }
      }),
      createEl('button', {
        className: 'btn btn--sm btn--ghost btn--danger',
        text: '삭제',
        attrs: { type: 'button', 'data-action': 'delete', 'aria-label': `${bean.id} 삭제` }
      })
    );

    row.append(
      idCell,
      farmCell,
      createEl('td', { text: bean.country_ko }),
      createEl('td', { text: bean.process_name_ko }),
      createEl('td', { className: 'num', text: formatScore(bean.score) }),
      createEl('td', { className: 'num bid', text: formatUsd(bean.bid_per_lb) }),
      noteCell,
      createEl('td', { children: [actions] })
    );
    el.beanRows.append(row);
  }
}

// ============================================================
// 로트 폼 (모달)
// ============================================================

// 가공방식 선택지는 processes 테이블이 원본이다. 화면에 값을 적어 두지 않는다.
async function loadProcesses() {
  state.processes = await api.get('/processes');
  state.processError = null;
  el.beanSubmit.disabled = false;
  clearChildren(el.processSelect);
  for (const process of state.processes) {
    el.processSelect.append(createEl('option', {
      text: `${process.name_ko} (${process.name_en})`,
      attrs: { value: process.key }
    }));
  }
}

// 감각 6축 입력칸을 만든다. 축이 여섯이라 마크업을 반복하지 않고 생성한다.
function buildAxisInputs() {
  clearChildren(el.axisGrid);
  for (const axis of SENSORY_AXES) {
    const field = createEl('div', { className: 'field' });
    field.append(
      createEl('label', { className: 'field__label', text: axis.label, attrs: { for: `f-${axis.key}` } }),
      createEl('input', {
        className: 'input',
        attrs: {
          type: 'number', id: `f-${axis.key}`, name: axis.key,
          min: '1', max: '5', step: '0.1', inputmode: 'decimal'
        }
      })
    );
    el.axisGrid.append(field);
  }
}

// 폼을 비우거나 기존 로트로 채운다.
function fillForm(bean) {
  el.beanForm.reset();
  clearFormError(el.beanError);
  el.beanSubmit.disabled = Boolean(state.processError);
  if (state.processError) showFormError(el.beanError, state.processError);

  const idField = el.beanForm.elements.id;
  state.editingId = bean?.id ?? null;

  if (bean) {
    el.dialogTitle.textContent = `로트 수정 — ${bean.id}`;
    // 로트 ID는 기본키라 바꾸면 다른 로트가 된다. 수정 중에는 잠근다.
    idField.value = bean.id;
    idField.readOnly = true;

    for (const [name, value] of Object.entries({
      farm: bean.farm, farmer: bean.farmer, country: bean.country, country_ko: bean.country_ko,
      region: bean.region, year: bean.year, award: bean.award, rank: bean.rank,
      category: bean.category, category_ko: bean.category_ko, score: bean.score,
      process_key: bean.process_key, bid_per_lb: bean.bid_per_lb,
      weight_lb: bean.weight_lb, total_value_usd: bean.total_value_usd
    })) {
      const field = el.beanForm.elements[name];
      if (field) field.value = value ?? '';
    }

    for (const axis of SENSORY_AXES) {
      el.beanForm.elements[axis.key].value = bean.sensory?.[axis.key] ?? '';
    }

    el.beanForm.elements.varieties.value = bean.varieties.join(', ');
    el.beanForm.elements.flavor_notes.value = bean.flavor_notes.join(', ');
    el.beanForm.elements.buyers.value = bean.buyers.join(', ');
  } else {
    el.dialogTitle.textContent = '로트 추가';
    idField.readOnly = false;
    el.beanForm.elements.year.value = '2025';
  }

  renderPreview();
}

// 저장 전 미리보기.
// 특히 쉼표 입력이 어떻게 나뉘는지 보여준다 — 공백이 붙었거나 쉼표를 빠뜨렸을 때
// 저장하고 나서야 알아채는 일을 막는다.
function renderPreview() {
  clearChildren(el.preview);
  const form = el.beanForm.elements;

  const summary = createEl('dl', { className: 'preview__summary' });
  const rows = [
    ['로트 ID', (form.id.value.trim() || '—').toUpperCase()],
    ['농장', form.farm.value.trim() || '—'],
    ['국가', form.country_ko.value.trim() || '—'],
    ['등급·순위', `${form.award.value}${form.rank.value ? ` ${form.rank.value}위` : ''}`],
    ['점수', form.score.value === '' ? '—' : formatScore(form.score.value)],
    ['가공', processNameOf(form.process_key.value)],
    ['낙찰가', form.bid_per_lb.value === '' ? '—' : `${formatUsd(form.bid_per_lb.value)} /lb`]
  ];
  for (const [label, value] of rows) {
    summary.append(
      createEl('dt', { text: label }),
      createEl('dd', { className: 'num', text: String(value) })
    );
  }
  el.preview.append(summary);

  // 감각 6축은 하나라도 있어야 저장된다는 것을 미리보기에서 알린다.
  const axes = SENSORY_AXES
    .filter((axis) => form[axis.key].value !== '')
    .map((axis) => `${axis.label} ${form[axis.key].value}`);
  el.preview.append(createEl('p', {
    className: 'preview__line',
    text: axes.length === 0 ? '감각 6축 — 기록 없이 저장됩니다' : `감각 6축 — ${axes.join(' · ')}`
  }));

  for (const [label, raw] of [
    ['품종', form.varieties.value],
    ['향미', form.flavor_notes.value],
    ['낙찰 업체', form.buyers.value]
  ]) {
    const names = splitNames(raw);
    const block = createEl('div', { className: 'preview__list' });
    block.append(createEl('span', { className: 'preview__label muted', text: `${label} ${names.length}건` }));

    if (names.length > 0) {
      const tags = createEl('ul', { className: 'tag-list', attrs: { role: 'list' } });
      for (const name of names) {
        // 관리자가 입력한 값이므로 innerHTML이 아니라 textContent로 넣는다.
        tags.append(createEl('li', { className: 'tag', text: name }));
      }
      block.append(tags);
    }
    el.preview.append(block);
  }
}

// 가공방식 key를 사람이 읽는 이름으로 바꾼다.
function processNameOf(key) {
  return state.processes.find((process) => process.key === key)?.name_ko ?? '—';
}

// 폼 값을 API가 받는 형태로 모은다.
// 검증은 서버가 다시 하므로 여기서는 형태만 맞춘다.
function collectForm() {
  const form = el.beanForm.elements;
  const body = {
    id: form.id.value.trim().toUpperCase(),
    farm: form.farm.value.trim(),
    farmer: emptyToNull(form.farmer.value),
    country: form.country.value.trim(),
    country_ko: form.country_ko.value.trim(),
    region: emptyToNull(form.region.value),
    year: emptyToNull(form.year.value),
    award: form.award.value,
    rank: emptyToNull(form.rank.value),
    category: emptyToNull(form.category.value),
    category_ko: emptyToNull(form.category_ko.value),
    score: emptyToNull(form.score.value),
    process_key: form.process_key.value,
    bid_per_lb: emptyToNull(form.bid_per_lb.value),
    weight_lb: emptyToNull(form.weight_lb.value),
    total_value_usd: emptyToNull(form.total_value_usd.value),
    varieties: splitNames(form.varieties.value),
    flavor_notes: splitNames(form.flavor_notes.value),
    buyers: splitNames(form.buyers.value)
  };

  const sensory = {};
  for (const axis of SENSORY_AXES) sensory[axis.key] = emptyToNull(form[axis.key].value);
  body.sensory = sensory;

  return body;
}

// 추가·수정 저장. 서버가 준 오류 문구를 그대로 모달 안에 남긴다.
async function submitBean(event) {
  event.preventDefault();
  clearFormError(el.beanError);

  if (state.processError) {
    showFormError(el.beanError, state.processError);
    return;
  }

  const body = collectForm();
  el.beanSubmit.disabled = true;

  try {
    if (state.editingId) await api.put(`/admin/beans/${encodeURIComponent(state.editingId)}`, body);
    else await api.post('/admin/beans', body);

    el.beanDialog.close();
    await Promise.all([loadBeans(), loadSummary()]);
  } catch (err) {
    showFormError(el.beanError, err instanceof ApiError ? err.message : '저장에 실패했습니다.');
  } finally {
    el.beanSubmit.disabled = Boolean(state.processError);
  }
}

// ============================================================
// 삭제
// ============================================================

// 삭제 확인 모달을 연다. 노트가 달려 있으면 서버가 거부하므로 미리 알려 준다.
function openDelete(bean) {
  state.deletingId = bean.id;
  clearFormError(el.deleteError);
  clearChildren(el.deleteTarget);

  el.deleteTarget.append(
    createEl('strong', { text: bean.farm }),
    createEl('span', { className: 'muted', text: ` (${bean.id})` })
  );

  if (bean.note_count > 0) {
    showFormError(el.deleteError, `노트 ${bean.note_count}건이 작성되어 삭제할 수 없습니다.`);
  }
  el.deleteDialog.showModal();
}

// 실제 삭제. 409는 서버가 참조 무결성 때문에 막은 경우다.
async function confirmDelete() {
  if (!state.deletingId) return;
  clearFormError(el.deleteError);
  el.deleteConfirm.disabled = true;

  try {
    await api.del(`/admin/beans/${encodeURIComponent(state.deletingId)}`);
    el.deleteDialog.close();
    state.deletingId = null;
    await Promise.all([loadBeans(), loadSummary()]);
  } catch (err) {
    // 409면 서버가 노트 수를 함께 준다. 왜 막혔는지 숫자로 보여 준다.
    if (err instanceof ApiError && err.status === 409) {
      const count = err.body?.noteCount;
      showFormError(
        el.deleteError,
        count === undefined
          ? err.message
          : `노트 ${count}건이 작성되어 삭제할 수 없습니다.`
      );
      // 목록의 노트 수가 오래됐을 수 있으니 다시 받는다.
      loadBeans();
    } else {
      showFormError(el.deleteError, err instanceof ApiError ? err.message : '삭제에 실패했습니다.');
    }
  } finally {
    el.deleteConfirm.disabled = false;
  }
}

// ============================================================
// 사용자 관리
// ============================================================

// 사용자 목록을 받아 표로 그린다.
async function loadUsers() {
  clearChildren(el.userState);
  showLoading(el.userState, 3);
  try {
    state.users = await api.get('/admin/users');
    clearChildren(el.userState);
    renderUserRows();
  } catch (err) {
    clearChildren(el.userState);
    showError(el.userState, err, loadUsers);
  }
}

// 권한 드롭다운을 포함한 사용자 표.
function renderUserRows() {
  clearChildren(el.userRows);
  if (state.users.length === 0) {
    el.userRows.append(emptyRow(6, '가입한 사용자가 없습니다.'));
    return;
  }

  for (const user of state.users) {
    const isMe = user.id === state.me.id;
    const row = createEl('tr');
    row.dataset.userId = String(user.id);

    const nameCell = createEl('th', { attrs: { scope: 'row' } });
    nameCell.append(createEl('span', { text: user.username }));
    if (isMe) nameCell.append(createEl('span', { className: 'muted admin-self', text: ' (나)' }));

    const roleCell = createEl('td');
    if (isMe) {
      // 자기 권한은 서버가 거부하므로 아예 바꿀 수 없게 둔다.
      roleCell.append(roleBadge(user.role));
    } else {
      const select = createEl('select', {
        className: 'select select--sm',
        attrs: { 'data-role-select': '', 'aria-label': `${user.username} 권한` }
      });
      for (const [value, label] of [['user', '일반'], ['admin', '관리자']]) {
        const option = createEl('option', { text: label, attrs: { value } });
        if (user.role === value) option.selected = true;
        select.append(option);
      }
      roleCell.append(select);
    }

    // td 자체를 flex로 만들면 브라우저의 표 레이아웃 계산에서 빠질 수 있다.
    // 작업 버튼만 안쪽 래퍼에 묶어 셀 의미와 열 너비를 유지한다.
    const actionCell = createEl('td');
    const actions = createEl('div', { className: 'admin-actions' });
    if (!isMe) {
      // 자기 계정은 서버가 거부하므로 버튼 자체를 두지 않는다.
      actions.append(createEl('button', {
        className: 'btn btn--sm btn--ghost btn--danger',
        text: '삭제',
        attrs: { type: 'button', 'data-action': 'delete-user', 'aria-label': `${user.username} 계정 삭제` }
      }));
    }
    actionCell.append(actions);

    row.append(
      nameCell,
      roleCell,
      createEl('td', { className: 'num', text: formatNumber(user.note_count) }),
      createEl('td', { className: 'num', text: formatNumber(user.favorite_count) }),
      createEl('td', { className: 'num', text: formatDate(user.created_at) }),
      actionCell
    );
    el.userRows.append(row);
  }
}

// 계정 삭제 확인 모달을 연다.
// 노트·즐겨찾기가 함께 사라지므로 몇 건인지 먼저 보여준다.
function openUserDelete(user) {
  state.deletingUserId = user.id;
  clearFormError(el.userDeleteError);
  clearChildren(el.userDeleteTarget);
  el.userDeleteConfirm.disabled = false;

  // 사용자가 정한 아이디라 textContent로 넣는다.
  el.userDeleteTarget.append(
    createEl('strong', { text: user.username }),
    createEl('span', { className: 'muted', text: user.role === 'admin' ? ' (관리자)' : '' })
  );

  const parts = [];
  if (user.note_count > 0) parts.push(`노트 ${formatNumber(user.note_count)}건`);
  if (user.favorite_count > 0) parts.push(`즐겨찾기 ${formatNumber(user.favorite_count)}건`);
  el.userDeleteImpact.textContent = parts.length === 0
    ? '작성한 노트와 즐겨찾기가 없습니다.'
    : `${parts.join('과 ')}도 함께 삭제됩니다.`;

  el.userDeleteDialog.showModal();
}

// 실제 계정 삭제. 서버가 거부하면 이유를 모달 안에 그대로 남긴다.
async function confirmUserDelete() {
  if (!state.deletingUserId) return;
  clearFormError(el.userDeleteError);
  el.userDeleteConfirm.disabled = true;

  try {
    await api.del(`/admin/users/${state.deletingUserId}`);
    el.userDeleteDialog.close();
    state.deletingUserId = null;
    await Promise.all([loadUsers(), loadSummary()]);
  } catch (err) {
    showFormError(el.userDeleteError, err instanceof ApiError ? err.message : '삭제에 실패했습니다.');
    // 이미 지워진 계정이라면 목록이 오래된 것이므로 다시 받는다.
    if (err instanceof ApiError && err.status === 404) loadUsers();
  } finally {
    el.userDeleteConfirm.disabled = false;
  }
}

// 권한 변경. 실패하면 드롭다운을 원래 값으로 되돌린다.
async function changeRole(select, userId) {
  const user = state.users.find((candidate) => candidate.id === userId);
  const previous = user?.role;
  const next = select.value;

  select.disabled = true;
  try {
    const updated = await api.patch(`/admin/users/${userId}/role`, { role: next });
    if (user) user.role = updated.role;
    await loadSummary();
  } catch (err) {
    // 화면과 서버가 어긋나면 안 되므로 선택을 되돌리고 이유를 알린다.
    if (previous) select.value = previous;
    clearChildren(el.userState);
    showError(el.userState, err, null);
  } finally {
    select.disabled = false;
  }
}

// ============================================================
// 이벤트 연결
// ============================================================

// 로트 표는 행이 계속 다시 그려지므로 위임으로 한 번만 연결한다.
function initBeanEvents() {
  let timer = null;
  el.beanSearch.addEventListener('input', () => {
    // 글자마다 요청하지 않도록 입력이 멎기를 기다린다.
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.search = el.beanSearch.value.trim();
      loadBeans();
    }, 300);
  });

  el.beanSort.addEventListener('change', () => {
    const [sort, order] = el.beanSort.value.split(':');
    state.sort = sort;
    state.order = order;
    loadBeans();
  });

  el.beanAdd.addEventListener('click', () => {
    fillForm(null);
    el.beanDialog.showModal();
  });

  el.beanRows.addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-bean-id]');
    if (!row) return;
    const bean = state.beans.find((candidate) => candidate.id === row.dataset.beanId);
    if (!bean) return;

    const action = event.target.closest('button')?.dataset.action;
    if (action === 'delete') {
      openDelete(bean);
      return;
    }
    // 수정 버튼이든 행 아무 곳이든 수정 폼을 연다.
    openEdit(bean.id);
  });
}

// 목록에는 요약만 있으므로 상세를 다시 받아 폼을 채운다.
async function openEdit(beanId) {
  try {
    const bean = await api.get(`/beans/${encodeURIComponent(beanId)}`);
    fillForm({
      ...bean,
      varieties: bean.varieties ?? [],
      flavor_notes: bean.flavor_notes ?? [],
      buyers: (bean.buyers ?? []).map((buyer) => (typeof buyer === 'string' ? buyer : buyer.name))
    });
    el.beanDialog.showModal();
  } catch (err) {
    clearChildren(el.beanState);
    showError(el.beanState, err, () => openEdit(beanId));
  }
}

// 모달 안쪽 이벤트.
function initDialogEvents() {
  el.beanForm.addEventListener('submit', submitBean);
  // 입력이 바뀔 때마다 미리보기를 다시 그린다.
  el.beanForm.addEventListener('input', renderPreview);
  el.beanForm.addEventListener('change', renderPreview);
  el.beanCancel.addEventListener('click', () => el.beanDialog.close());

  el.deleteConfirm.addEventListener('click', confirmDelete);
  el.deleteCancel.addEventListener('click', () => el.deleteDialog.close());
  el.deleteDialog.addEventListener('close', () => { state.deletingId = null; });
}

// 사용자 표의 권한 드롭다운과 삭제 버튼을 위임으로 연결한다.
function initUserEvents() {
  el.userRows.addEventListener('change', (event) => {
    const select = event.target.closest('[data-role-select]');
    if (!select) return;
    const userId = Number(select.closest('tr').dataset.userId);
    changeRole(select, userId);
  });

  el.userRows.addEventListener('click', (event) => {
    if (event.target.closest('button')?.dataset.action !== 'delete-user') return;
    const userId = Number(event.target.closest('tr').dataset.userId);
    const user = state.users.find((candidate) => candidate.id === userId);
    if (user) openUserDelete(user);
  });

  el.userDeleteConfirm.addEventListener('click', confirmUserDelete);
  el.userDeleteCancel.addEventListener('click', () => el.userDeleteDialog.close());
  el.userDeleteDialog.addEventListener('close', () => { state.deletingUserId = null; });
}

// ============================================================
// 시작
// ============================================================

// 권한 확인이 끝난 뒤에만 데이터를 요청한다.
async function init() {
  await layoutReady;
  if (!(await gate())) return;

  initTabs();
  initBeanEvents();
  initDialogEvents();
  initUserEvents();
  buildAxisInputs();

  // 가공방식은 폼이 열리기 전에 있어야 한다.
  try {
    await loadProcesses();
  } catch {
    // 선택지를 못 받아도 나머지 화면은 쓸 수 있게 둔다.
    state.processError = '가공방식 목록을 불러오지 못했습니다. 새로고침해 주세요.';
    el.beanSubmit.disabled = true;
  }

  await Promise.all([loadSummary(), loadBeans(), loadUsers()]);
}

init();
