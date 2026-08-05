// notes.html — 내 테이스팅 노트 CRUD.
//
// 목록의 수정·삭제 버튼은 카드마다 리스너를 붙이지 않고 컨테이너 하나에서 받는다(이벤트 위임).
// 노트를 다시 그릴 때마다 리스너를 떼고 붙이면 새는 곳이 생기기 쉽다.
import {
  layoutReady, api, ApiError, requireLogin,
  createEl, clearChildren,
  showLoading, showError, showEmpty,
  formatScore, formatUsd, formatDate, formatNumber, renderLotCard
} from './common.js';

const COMMENT_MAX = 500;
const SENSORY_AXES = [
  { key: 'aroma', label: '향' },
  { key: 'acidity', label: '산미' },
  { key: 'body', label: '바디' },
  { key: 'sweetness', label: '단맛' },
  { key: 'aftertaste', label: '후미' },
  { key: 'balance', label: '밸런스' }
];

const createForm = document.querySelector('[data-form="create"]');
const editForm = document.querySelector('[data-form="edit"]');
const editDialog = document.querySelector('[data-edit-dialog]');
const deleteDialog = document.querySelector('[data-delete-dialog]');
const noteList = document.querySelector('[data-note-list]');
const noteCount = document.querySelector('[data-note-count]');
const favList = document.querySelector('[data-fav-list]');
const favCount = document.querySelector('[data-fav-count]');

// 화면에 올라와 있는 노트. 수정 모달을 채울 때 다시 조회하지 않으려고 들고 있는다.
let notes = [];
// 삭제 확인 모달이 물어보고 있는 대상.
let pendingDelete = null;

// ============================================================
// 폼 조각 만들기 — 작성 폼과 수정 폼이 같은 구조를 쓴다
// ============================================================

// 별점 라디오 5개. 같은 name으로 묶어야 하나만 선택된다.
function buildRating(fieldset, prefix) {
  for (let value = 1; value <= 5; value += 1) {
    const id = `${prefix}-rating-${value}`;
    const input = createEl('input', {
      attrs: { type: 'radio', name: 'rating', value: String(value), id }
    });
    const label = createEl('label', {
      className: 'rating__star',
      attrs: { for: id, title: `${value}점` },
      children: [input, createEl('span', { text: '★' })]
    });
    fieldset.append(label);
  }
}

// 감각 6축 슬라이더. 값을 비우면 미입력으로 보내야 해서 "사용" 체크박스를 함께 둔다.
function buildSensory(container, prefix) {
  for (const axis of SENSORY_AXES) {
    const id = `${prefix}-${axis.key}`;
    const range = createEl('input', {
      attrs: { type: 'range', id, name: axis.key, min: '0', max: '5', step: '0.5', value: '3' }
    });
    range.disabled = true;

    const toggle = createEl('input', {
      attrs: { type: 'checkbox', 'aria-label': `${axis.label} 기록하기` }
    });
    toggle.dataset.enable = axis.key;

    const output = createEl('output', { className: 'num', text: '—' });

    // 체크를 켜야 슬라이더가 살아난다. 꺼져 있으면 서버로 보내지 않는다.
    toggle.addEventListener('change', () => {
      range.disabled = !toggle.checked;
      output.textContent = toggle.checked ? range.value : '—';
    });
    range.addEventListener('input', () => {
      output.textContent = range.value;
    });

    container.append(createEl('div', {
      className: 'range range--note',
      children: [toggle, createEl('label', { attrs: { for: id }, text: axis.label }), range, output]
    }));
  }
}

// 폼에서 감각 값을 읽는다. 체크가 꺼진 축은 null로 보내 서버가 미입력으로 저장하게 한다.
function readSensory(form) {
  const values = {};
  for (const axis of SENSORY_AXES) {
    const toggle = form.querySelector(`[data-enable="${axis.key}"]`);
    const range = form.querySelector(`[name="${axis.key}"]`);
    values[axis.key] = toggle?.checked ? Number(range.value) : null;
  }
  return values;
}

// 노트 값을 폼에 채운다. 수정 모달을 열 때 쓴다.
function fillSensory(form, note) {
  for (const axis of SENSORY_AXES) {
    const toggle = form.querySelector(`[data-enable="${axis.key}"]`);
    const range = form.querySelector(`[name="${axis.key}"]`);
    const output = range.parentElement.querySelector('output');
    const value = note[axis.key];
    const hasValue = value !== null && value !== undefined;

    toggle.checked = hasValue;
    range.disabled = !hasValue;
    range.value = hasValue ? String(value) : '3';
    output.textContent = hasValue ? String(value) : '—';
  }
}

// 코멘트 글자 수 표시.
function bindCharCount(textareaId) {
  const textarea = document.querySelector(`#${textareaId}`);
  const counter = document.querySelector(`[data-count-for="${textareaId}"]`);
  const update = () => {
    // 서버와 같은 기준(코드포인트)으로 센다. 이모지가 두 글자로 세이지 않도록.
    counter.textContent = `${[...textarea.value].length} / ${COMMENT_MAX}`;
  };
  textarea.addEventListener('input', update);
  update();
}

// ============================================================
// 검증
// ============================================================

function showFormError(name, message) {
  const slot = document.querySelector(`[data-error="${name}"]`);
  slot.textContent = message;
  slot.hidden = message === '';
}

// 폼 값을 읽어 서버로 보낼 형태로 만든다. 문제가 있으면 { error }를 돌려준다.
function readNoteForm(form) {
  const beanId = form.bean_id.value;
  if (beanId === '') return { error: '로트를 선택해 주세요.' };

  const rating = form.querySelector('input[name="rating"]:checked');
  if (!rating) return { error: '별점을 선택해 주세요.' };

  const comment = form.comment.value;
  if ([...comment.trim()].length > COMMENT_MAX) {
    return { error: `코멘트는 ${COMMENT_MAX}자 이하로 입력해 주세요.` };
  }

  return {
    value: {
      bean_id: beanId,
      brew_method: form.brew_method.value.trim(),
      rating: Number(rating.value),
      comment: comment.trim(),
      ...readSensory(form)
    }
  };
}

function messageFrom(error) {
  return error instanceof ApiError ? error.message : '요청을 보내지 못했습니다.';
}

// ============================================================
// 노트 카드
// ============================================================

function renderStars(rating) {
  return createEl('span', {
    className: 'note-card__stars',
    text: '★'.repeat(rating) + '☆'.repeat(5 - rating),
    attrs: { 'aria-label': `5점 만점에 ${rating}점` }
  });
}

// 카드 하나. 수정·삭제 버튼에는 노트 id만 심어 두고 처리는 위임 리스너가 한다.
function renderNoteCard(note) {
  const card = createEl('article', { className: 'note-card' });

  const head = createEl('div', {
    className: 'note-card__head',
    children: [
      createEl('div', {
        children: [
          createEl('a', {
            className: 'note-card__bean',
            text: note.farm,
            attrs: { href: `/detail.html?id=${encodeURIComponent(note.bean_id)}` }
          }),
          createEl('p', {
            className: 'note-card__meta',
            text: [note.country_ko, note.process_name_ko, `총점 ${formatScore(note.bean_score)}`]
              .filter(Boolean).join(' · ')
          })
        ]
      }),
      renderStars(note.rating)
    ]
  });

  const info = createEl('p', {
    className: 'note-card__meta num',
    text: [note.brew_method, formatDate(note.created_at)].filter(Boolean).join(' · ')
  });

  card.append(head, info);

  // 사용자가 쓴 글이라 textContent로 넣는다. innerHTML을 쓰면 태그가 실행된다.
  if (note.comment) {
    card.append(createEl('p', { className: 'note-card__comment', text: note.comment }));
  }

  const recorded = SENSORY_AXES
    .filter((axis) => note[axis.key] !== null && note[axis.key] !== undefined)
    .map((axis) => `${axis.label} ${note[axis.key]}`);
  if (recorded.length > 0) {
    card.append(createEl('p', { className: 'note-card__sensory num', text: recorded.join(' · ') }));
  }

  card.append(createEl('div', {
    className: 'note-card__actions',
    children: [
      createEl('button', {
        className: 'btn btn--sm', text: '수정',
        attrs: { type: 'button', 'data-action': 'edit', 'data-id': String(note.id) }
      }),
      createEl('button', {
        className: 'btn btn--sm btn--danger', text: '삭제',
        attrs: { type: 'button', 'data-action': 'delete', 'data-id': String(note.id) }
      })
    ]
  }));

  return card;
}

// ============================================================
// 불러오기
// ============================================================

async function loadBeanOptions() {
  // 선택 목록이라 74건을 모두 받는다. 거르는 용도가 아니라 고르는 용도다.
  const { items } = await api.get('/beans?limit=100&sort=score&order=desc');

  const preselect = new URLSearchParams(location.search).get('bean');

  for (const select of [createForm.bean_id, editForm.bean_id]) {
    clearChildren(select);
    select.append(createEl('option', { text: '로트를 선택하세요', attrs: { value: '' } }));
    for (const bean of items) {
      select.append(createEl('option', {
        text: `${bean.farm} · ${bean.country_ko} · ${formatScore(bean.score)}`,
        attrs: { value: bean.id }
      }));
    }
  }

  // detail.html에서 "이 로트로 노트 쓰기"를 눌러 왔으면 미리 골라 둔다.
  if (preselect) createForm.bean_id.value = preselect;
}

async function loadNotes() {
  showLoading(noteList, 2);
  try {
    notes = await api.get('/notes');
    noteCount.textContent = `${formatNumber(notes.length)}건`;

    clearChildren(noteList);
    if (notes.length === 0) {
      return showEmpty(noteList, '아직 노트가 없습니다. 왼쪽에서 첫 노트를 남겨 보세요.');
    }
    for (const note of notes) noteList.append(renderNoteCard(note));
  } catch (error) {
    noteCount.textContent = '';
    showError(noteList, error, loadNotes);
  }
}

async function loadFavorites() {
  showLoading(favList, 2);
  try {
    const favorites = await api.get('/favorites');
    favCount.textContent = `${formatNumber(favorites.length)}건`;

    clearChildren(favList);
    if (favorites.length === 0) {
      return showEmpty(favList, '즐겨찾기한 로트가 없습니다. 상세 화면에서 담을 수 있습니다.');
    }
    // 즐겨찾기 응답은 bean_id로 오지만 카드가 쓰는 모양과 같아 그대로 넘긴다.
    for (const row of favorites) {
      favList.append(renderLotCard({ ...row, id: row.bean_id }));
    }
  } catch (error) {
    favCount.textContent = '';
    showError(favList, error, loadFavorites);
  }
}

// ============================================================
// 작성
// ============================================================

createForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  showFormError('create', '');

  const { error, value } = readNoteForm(createForm);
  if (error) return showFormError('create', error);

  const button = createForm.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api.post('/notes', value);
    createForm.reset();
    // reset()은 JS가 만든 슬라이더의 비활성 상태까지 되돌리지 못하므로 직접 맞춘다.
    fillSensory(createForm, {});
    document.querySelector('[data-count-for="create-comment"]').textContent = `0 / ${COMMENT_MAX}`;
    await loadNotes();
  } catch (err) {
    if (err instanceof ApiError && err.isUnauthorized) return requireLogin();
    showFormError('create', messageFrom(err));
  } finally {
    button.disabled = false;
  }
});

// ============================================================
// 목록의 수정·삭제 — 이벤트 위임
// ============================================================

noteList.addEventListener('click', (event) => {
  // 카드마다 리스너를 달지 않고, 눌린 지점에서 가장 가까운 버튼을 찾아 처리한다.
  const button = event.target.closest('[data-action]');
  if (!button || !noteList.contains(button)) return;

  const note = notes.find((n) => String(n.id) === button.dataset.id);
  if (!note) return;

  if (button.dataset.action === 'edit') openEdit(note);
  if (button.dataset.action === 'delete') openDelete(note);
});

function openEdit(note) {
  showFormError('edit', '');
  editForm.bean_id.value = note.bean_id;
  editForm.brew_method.value = note.brew_method ?? '';
  editForm.comment.value = note.comment ?? '';

  const rating = editForm.querySelector(`input[name="rating"][value="${note.rating}"]`);
  if (rating) rating.checked = true;

  fillSensory(editForm, note);
  document.querySelector('[data-count-for="edit-comment"]').textContent =
    `${[...(note.comment ?? '')].length} / ${COMMENT_MAX}`;

  editForm.dataset.noteId = String(note.id);
  editDialog.showModal();
}

editForm.addEventListener('submit', async (event) => {
  // method="dialog" 폼이라 기본 동작은 모달을 닫는 것이다. 저장이 끝난 뒤에 닫는다.
  event.preventDefault();
  showFormError('edit', '');

  const { error, value } = readNoteForm(editForm);
  if (error) return showFormError('edit', error);

  const button = editForm.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api.put(`/notes/${editForm.dataset.noteId}`, value);
    editDialog.close();
    await loadNotes();
  } catch (err) {
    if (err instanceof ApiError && err.isUnauthorized) return requireLogin();
    showFormError('edit', messageFrom(err));
  } finally {
    button.disabled = false;
  }
});

document.querySelector('[data-close-edit]').addEventListener('click', () => editDialog.close());

// ============================================================
// 삭제 확인 모달
// ============================================================

function openDelete(note) {
  pendingDelete = note;
  // 어떤 노트를 지우는지 보여준다. 농장명은 사용자 입력이 아니지만 규칙대로 textContent로 넣는다.
  document.querySelector('[data-delete-target]').textContent =
    `${note.farm} · ${formatDate(note.created_at)}`;
  deleteDialog.showModal();
}

document.querySelector('[data-cancel-delete]').addEventListener('click', () => {
  pendingDelete = null;
  deleteDialog.close();
});

document.querySelector('[data-confirm-delete]').addEventListener('click', async (event) => {
  if (!pendingDelete) return;
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await api.del(`/notes/${pendingDelete.id}`);
    deleteDialog.close();
    pendingDelete = null;
    await loadNotes();
  } catch (err) {
    if (err instanceof ApiError && err.isUnauthorized) return requireLogin();
    deleteDialog.close();
    showError(noteList, err, loadNotes);
  } finally {
    button.disabled = false;
  }
});

// ============================================================
// 시작
// ============================================================

await layoutReady;

// 로그인하지 않았으면 여기서 로그인 페이지로 보낸다. 돌아올 주소를 함께 넘긴다.
if (requireLogin()) {
  buildRating(createForm.querySelector('[data-rating]'), 'create');
  buildRating(editForm.querySelector('[data-rating]'), 'edit');
  buildSensory(createForm.querySelector('[data-sensory]'), 'create');
  buildSensory(editForm.querySelector('[data-sensory]'), 'edit');
  bindCharCount('create-comment');
  bindCharCount('edit-comment');

  try {
    await loadBeanOptions();
  } catch {
    createForm.bean_id.replaceChildren();
    createForm.bean_id.append(createEl('option', { text: '로트를 불러오지 못했습니다', attrs: { value: '' } }));
  }

  await Promise.all([loadNotes(), loadFavorites()]);
}
