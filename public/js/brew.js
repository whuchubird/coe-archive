// brew.html — 추출 계산기와 4단계 타이머.
// 계산은 전부 화면 안에서 끝난다(서버에 보낼 것이 없다).
// 서버에서 받는 건 로트 목록 하나뿐이고, 가공방식을 알아야 권장 비율을 제안할 수 있어서다.
import { layoutReady, api, createEl, clearChildren, formatScore } from './common.js';

// 가공방식별 권장 물 비율. 값 자체는 일반적인 핸드드립 기준이고,
// 왜 다른지는 가공방식이 남기는 단맛·바디 차이 때문이다.
const RECOMMENDED_RATIO = {
  washed: 16.5,          // 깔끔한 산미를 살리려면 조금 묽게
  honey: 16,
  'pulped-natural': 15.5,
  natural: 15,           // 단맛과 바디가 두꺼워 진하게 뽑아도 버틴다
  experimental: 15.5
};

// 4단계. 각 단계의 길이(초)와 그 단계에서 부을 물의 비중.
const STEPS = [
  { name: '뜸들이기', seconds: 45, share: 0.15 },
  { name: '1차 붓기', seconds: 45, share: 0.35 },
  { name: '2차 붓기', seconds: 45, share: 0.30 },
  { name: '마무리', seconds: 45, share: 0.20 }
];

const TOTAL_SECONDS = STEPS.reduce((sum, s) => sum + s.seconds, 0);

const beanSelect = document.querySelector('[data-bean]');
const beanHint = document.querySelector('[data-bean-hint]');
const doseInput = document.querySelector('[data-dose]');
const ratioInput = document.querySelector('[data-ratio]');
const doseOut = document.querySelector('[data-dose-out]');
const ratioOut = document.querySelector('[data-ratio-out]');
const waterOut = document.querySelector('[data-water]');
const yieldOut = document.querySelector('[data-yield]');

const clockOut = document.querySelector('[data-clock]');
const progressBar = document.querySelector('[data-progress-bar]');
const progressFill = document.querySelector('[data-progress-fill]');
const stepName = document.querySelector('[data-step-name]');
const stepList = document.querySelector('[data-steps]');
const startButton = document.querySelector('[data-start]');
const pauseButton = document.querySelector('[data-pause]');
const resetButton = document.querySelector('[data-reset]');

// 로트 id → 가공방식. 선택했을 때 권장 비율을 찾는 데 쓴다.
const beanProcess = new Map();

// ============================================================
// 계산
// ============================================================

function currentDose() {
  return Number(doseInput.value);
}

// 슬라이더가 가리키는 물 비율. 1:N 의 N이다.
function currentRatio() {
  return Number(ratioInput.value);
}

// 총 물량 = 원두량 × 비율. 이 화면의 결론이라 한 곳에서만 계산한다.
function totalWater() {
  return Math.round(currentDose() * currentRatio());
}

// 슬라이더를 움직일 때마다 다시 그린다. 서버 왕복이 없어 즉시 반응한다.
function updateCalculation() {
  doseOut.textContent = `${currentDose()} g`;
  ratioOut.textContent = `1:${currentRatio()}`;
  waterOut.textContent = `${totalWater()} g`;
  // 원두가 물을 머금어 잔에 남는 양은 대략 원두 무게의 두 배만큼 줄어든다.
  const cup = Math.max(0, totalWater() - Math.round(currentDose() * 2));
  yieldOut.textContent = `잔에 담기는 양 약 ${cup} g · 총 ${TOTAL_SECONDS}초`;
  renderSteps();
}

// 단계별로 "이때까지 몇 g을 부어야 하는지" 누적으로 보여준다.
function renderSteps() {
  clearChildren(stepList);
  const water = totalWater();
  // 단계마다 반올림해서 더하면 오차가 쌓여 마지막 누적이 총량과 어긋난다(450 → 451).
  // 정확한 값을 누적한 뒤 표시할 때만 반올림한다. 비중의 합이 1이라 마지막은 총량과 같아진다.
  let exact = 0;
  let elapsed = 0;

  for (const [index, step] of STEPS.entries()) {
    exact += water * step.share;
    const poured = Math.round(exact);
    elapsed += step.seconds;

    const item = createEl('li', { className: 'brew-steps__item' });
    item.dataset.index = String(index);
    item.append(
      createEl('span', { className: 'brew-steps__name', text: step.name }),
      createEl('span', { className: 'brew-steps__water num', text: `누적 ${poured} g` }),
      createEl('span', { className: 'brew-steps__time num', text: formatClock(elapsed) })
    );
    stepList.append(item);
  }
}

// ============================================================
// 타이머
// ============================================================

let elapsedSeconds = 0;
let intervalId = null;

// 초를 분:초로 바꾼다. 초는 두 자리로 맞춰 자릿수가 흔들리지 않게 한다.
function formatClock(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// 지금이 몇 번째 단계인지 누적 시간으로 찾는다.
function stepIndexAt(seconds) {
  let bound = 0;
  for (const [index, step] of STEPS.entries()) {
    bound += step.seconds;
    if (seconds < bound) return index;
  }
  return STEPS.length - 1;
}

// 시계·진행바·현재 단계 강조를 한 번에 맞춘다. 따로 갱신하면 서로 어긋난다.
function updateTimerView() {
  clockOut.textContent = formatClock(elapsedSeconds);

  const ratio = Math.min(1, elapsedSeconds / TOTAL_SECONDS);
  // width 대신 scaleX로 늘린다. 폭을 바꾸면 매 프레임 레이아웃을 다시 계산하지만,
  // 변형은 합성 단계에서 끝난다. 보이는 결과는 같다.
  progressFill.style.transform = `scaleX(${ratio.toFixed(4)})`;
  progressBar.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));

  const finished = elapsedSeconds >= TOTAL_SECONDS;
  const index = stepIndexAt(elapsedSeconds);
  stepName.textContent = finished ? '완료' : STEPS[index].name;

  for (const item of stepList.children) {
    const itemIndex = Number(item.dataset.index);
    item.classList.toggle('is-active', !finished && itemIndex === index);
    item.classList.toggle('is-done', finished || itemIndex < index);
  }
}

// 1초마다 불린다. 총 시간에 닿으면 스스로 멈춘다.
function tick() {
  elapsedSeconds += 1;
  updateTimerView();
  if (elapsedSeconds >= TOTAL_SECONDS) stopTimer();
}

// 타이머 시작. 이미 돌고 있거나 끝난 상태면 아무것도 하지 않는다.
function startTimer() {
  if (intervalId !== null || elapsedSeconds >= TOTAL_SECONDS) return;
  intervalId = setInterval(tick, 1000);
  startButton.disabled = true;
  pauseButton.disabled = false;
}

// 진행을 멈춘다. 경과 시간은 남겨 두어 이어서 시작할 수 있다.
function stopTimer() {
  if (intervalId !== null) clearInterval(intervalId);
  intervalId = null;
  startButton.disabled = elapsedSeconds >= TOTAL_SECONDS;
  pauseButton.disabled = true;
}

// 처음 상태로 되돌린다. 멈춤과 달리 경과 시간까지 지운다.
function resetTimer() {
  stopTimer();
  elapsedSeconds = 0;
  startButton.disabled = false;
  stepName.textContent = '시작 전';
  updateTimerView();
}

startButton.addEventListener('click', startTimer);
pauseButton.addEventListener('click', stopTimer);
resetButton.addEventListener('click', resetTimer);

// ============================================================
// 로트 선택 → 권장 비율
// ============================================================

function applyRecommendation(beanId) {
  const process = beanProcess.get(beanId);
  if (!process) {
    beanHint.textContent = '로트를 고르면 가공방식에 맞는 비율을 제안합니다.';
    return;
  }

  const ratio = RECOMMENDED_RATIO[process.key];
  if (ratio === undefined) return;

  ratioInput.value = String(ratio);
  updateCalculation();
  beanHint.textContent = `${process.name} 가공이라 1:${ratio}을 제안합니다. 슬라이더로 바꿔도 됩니다.`;
}

// 로트 목록을 받아 선택 상자를 채운다. 가공방식을 알아야 권장 비율을 제안할 수 있다.
async function loadBeans() {
  try {
    // 고르는 용도라 74건을 모두 받는다.
    const { items } = await api.get('/beans?limit=100&sort=score&order=desc');

    clearChildren(beanSelect);
    beanSelect.append(createEl('option', { text: '로트 없이 계산', attrs: { value: '' } }));
    for (const bean of items) {
      beanProcess.set(bean.id, { key: bean.process_key, name: bean.process_name_ko });
      beanSelect.append(createEl('option', {
        text: `${bean.farm} · ${bean.process_name_ko} · ${formatScore(bean.score)}`,
        attrs: { value: bean.id }
      }));
    }

    // 상세 화면에서 넘어온 경우 미리 골라 둔다.
    const preselect = new URLSearchParams(location.search).get('bean');
    if (preselect && beanProcess.has(preselect)) {
      beanSelect.value = preselect;
      applyRecommendation(preselect);
    }
  } catch {
    clearChildren(beanSelect);
    beanSelect.append(createEl('option', { text: '로트를 불러오지 못했습니다', attrs: { value: '' } }));
    beanHint.textContent = '로트 목록 없이도 계산기는 그대로 쓸 수 있습니다.';
  }
}

// ============================================================
// 시작
// ============================================================

doseInput.addEventListener('input', updateCalculation);
ratioInput.addEventListener('input', updateCalculation);
beanSelect.addEventListener('change', () => applyRecommendation(beanSelect.value));

updateCalculation();
resetTimer();

await layoutReady;
await loadBeans();
