// 画面制御
import { OcrEngine, loadImage, extractVoteCards, extractDateTime } from './ocr.js';
import { parsePower, formatPowerM, formTeams, buildAnnouncement, topMember, nameSimilarity, DEFAULT_TEMPLATE, DEFAULT_EVENT_NAME } from './matching.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

// ?ocr=local を付けると ./vendor 配下のファイル(オフライン用)を使う
const params = new URLSearchParams(location.search);
// ?ocr=local または window.OCR_LOCAL=true で ./vendor 配下のファイル(オフライン用)を使う。
// window.OCR_LANG_URLS={jpn,eng} があれば言語データはページ側で取得してワーカーに渡す(Artifact 配信用)
const abs = (p) => new URL(p, location.href).href;
const ocrPaths = (params.get('ocr') === 'local' || window.OCR_LOCAL === true)
  ? {
      workerPath: abs('./vendor/worker.min.js'),
      corePath: abs('./vendor/'),
      ...(window.OCR_LANG_URLS
        ? { langUrls: Object.fromEntries(Object.entries(window.OCR_LANG_URLS).map(([k, v]) => [k, abs(v)])) }
        : { langPath: abs('./vendor/lang'), gzip: true }),
    }
  : {};
const engine = new OcrEngine(ocrPaths);

const state = {
  voters: [],        // {id, name, power, nameConf, powerConf}
  teams: [],
  dateTime: '',      // スクショから読んだ開催日時("9/24(木)22:30")
  dateTimeSource: '',// 'ocr' | 'manual' | ''
  leaderName: null,  // 本部リーダー(null なら最上位を自動)
};

/* ---------- 共通 ---------- */
function setStatus(id, msg, isErr = false) {
  const el = $(id);
  el.textContent = msg;
  el.classList.toggle('err', isErr);
}

function switchTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === name));
  $$('.screen').forEach((s) => s.classList.toggle('on', s.id === `screen-${name}`));
}
$$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

function bindDrop(dropId, inputId, handler) {
  const drop = $(dropId), input = $(inputId);
  input.addEventListener('change', () => { if (input.files.length) handler(Array.from(input.files)); input.value = ''; });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault(); drop.classList.remove('over');
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
    if (files.length) handler(files);
  });
}

function addThumb(containerId, file) {
  const img = document.createElement('img');
  img.src = URL.createObjectURL(file);
  img.alt = file.name;
  img.onload = () => URL.revokeObjectURL(img.src);
  $(containerId).appendChild(img);
}

/* ---------- 投票メンバー読み取り ---------- */
bindDrop('#drop-vote', '#file-vote', async (files) => {
  files.forEach((f) => addThumb('#thumbs-vote', f));
  try {
    await engine.init((m) => setStatus('#status-vote', m));
    for (const [i, f] of files.entries()) {
      const prefix = files.length > 1 ? `画像 ${i + 1}/${files.length}: ` : '';
      const { rows } = await extractVoteCards(engine, f, (m) => setStatus('#status-vote', prefix + m));
      for (const r of rows) {
        if (!r.name && r.power == null) continue;
        const dup = state.voters.find((v) => nameSimilarity(v.name, r.name) >= 0.9 && (v.power == null || r.power == null || Math.abs(v.power - r.power) < 2e5));
        if (dup) continue;
        state.voters.push({ id: newId(), name: r.name, power: r.power, nameConf: r.nameConf, powerConf: r.powerConf });
      }
    }
    renderVoters();
    renderAnnouncement();
    $('#state-vote').textContent = `✔ ${state.voters.length} 人`;
    setStatus('#status-vote', `${state.voters.length} 人を読み取りました。${state.dateTime ? '' : '同盟投票のスクショも選ぶと開催日時が入ります。'}内容を確認して「組分けを作成」へ進んでください。`);
  } catch (err) {
    console.error(err);
    setStatus('#status-vote', '読み取りに失敗しました: ' + err.message, true);
  }
});

/* ---------- 同盟投票(開催日時)読み取り ---------- */
bindDrop('#drop-poll', '#file-poll', async (files) => {
  const f = files[0];
  addThumb('#thumbs-vote', f);
  try {
    await engine.init((m) => setStatus('#status-vote', m));
    setStatus('#status-vote', '開催日時を探しています…');
    const img = await loadImage(f);
    const { found } = await extractDateTime(engine, img);
    if (found) {
      state.dateTime = found.text; state.dateTimeSource = 'ocr';
      $('#state-poll').textContent = `✔ ${found.text}`;
      setStatus('#status-vote', `開催日時: ${found.text} と読み取りました。${state.voters.length ? '' : '投票メンバーのスクショも選んでください。'}`);
    } else {
      $('#state-poll').textContent = '読み取れず';
      setStatus('#status-vote', '開催日時が見つかりませんでした。お知らせ文の「開催日時」欄に入力してください。', true);
    }
    renderAnnouncement();
  } catch (err) {
    console.error(err);
    setStatus('#status-vote', '読み取りに失敗しました: ' + err.message, true);
  }
});

function renderVoters() {
  $('#voters-card').hidden = state.voters.length === 0;
  $('#teams-card').hidden = state.voters.length === 0;
  const tbody = $('#voters-table tbody');
  tbody.innerHTML = state.voters.map((v, i) => {
    const warn = v.nameConf < 60 || v.powerConf < 60 || v.power == null || !v.name;
    return `<tr data-id="${esc(v.id)}" class="${warn ? 'warn' : ''}">
      <td>${i + 1}</td>
      <td><input type="text" class="name" data-field="name" value="${esc(v.name)}"><div class="conf">信頼度 ${v.nameConf ?? '-'}</div></td>
      <td><input type="text" class="pow" data-field="power" value="${esc(v.power != null ? formatPowerM(v.power) : '')}"><div class="conf">信頼度 ${v.powerConf ?? '-'}</div></td>
      <td><button class="del" title="除外" data-del>✕</button></td>
    </tr>`;
  }).join('');
  tbody.querySelectorAll('input').forEach((el) => el.addEventListener('change', (e) => {
    const v = state.voters.find((x) => x.id === e.target.closest('tr').dataset.id);
    if (e.target.dataset.field === 'name') { v.name = e.target.value.trim(); v.nameConf = 100; }
    else { v.power = parsePower(e.target.value); v.powerConf = 100; }
    renderVoters();
  }));
  tbody.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', (e) => {
    const id = e.target.closest('tr').dataset.id;
    state.voters = state.voters.filter((x) => x.id !== id);
    renderVoters();
  }));
}

$('#btn-add-voter').addEventListener('click', () => {
  // 空の行を追加して表の中で入力してもらう(ダイアログが使えない環境でも動く)
  const id = newId();
  state.voters.push({ id, name: '', power: null, nameConf: 100, powerConf: 100 });
  renderVoters();
  const input = $(`tr[data-id="${id}"] input.name`);
  if (input) input.focus();
});
$('#btn-clear-voters').addEventListener('click', () => {
  state.voters = []; state.teams = []; state.leaderName = null;
  if (state.dateTimeSource === 'ocr') { state.dateTime = ''; state.dateTimeSource = ''; }
  $('#thumbs-vote').innerHTML = ''; $('#state-vote').textContent = ''; $('#state-poll').textContent = '';
  $('#teams').innerHTML = ''; $('#teams-actions').hidden = true; $('#announce-card').hidden = true;
  setStatus('#status-vote', '');
  renderVoters();
});

/* ---------- 組分け ---------- */
function buildTeams() {
  const members = state.voters.map((v) => ({ name: v.name, power: v.power ?? 0 })).filter((m) => m.name);
  const missing = members.filter((m) => !m.power).length;
  state.teams = formTeams(members, {
    size: parseInt($('#opt-size').value, 10) || 3,
    remainder: $('#opt-remainder').value,
    balance: $('#opt-balance').checked,
  });
  renderTeams();
  if (missing) setStatus('#status-vote', `${missing} 人は戦力が不明のため 0 として扱いました。表で戦力を入力すると反映されます。`);
}

function renderTeams() {
  const el = $('#teams');
  el.innerHTML = state.teams.map((t) => `<div class="team">
    <h4>${t.no}組 <span>合計 ${formatPowerM(t.total)}</span></h4>
    <ul>${t.members.map((m, i) => `<li class="${i === 0 ? 'leader' : ''}"><span>${esc(m.name)}</span><span class="p">${formatPowerM(m.power)}</span></li>`).join('')}</ul>
  </div>`).join('');
  $('#teams-actions').hidden = state.teams.length === 0;
  $('#announce-card').hidden = state.teams.length === 0;
  renderAnnouncement();
}

$('#btn-form').addEventListener('click', buildTeams);
$('#btn-shuffle').addEventListener('click', () => {
  // 同じリーダー配置のまま、非リーダーをランダムに入れ替えて別解を出す
  if (!state.teams.length) return buildTeams();
  const pool = state.teams.flatMap((t) => t.members.slice(1));
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  let k = 0;
  state.teams = state.teams.map((t) => {
    const members = [t.members[0], ...t.members.slice(1).map(() => pool[k++])].sort((a, b) => b.power - a.power);
    return { ...t, members, total: members.reduce((s, m) => s + m.power, 0) };
  });
  renderTeams();
});

/* ---------- お知らせ文 ---------- */
const ANN_KEY = 'alliance-match:announcement:v2';
function loadAnnPrefs() {
  const def = { template: DEFAULT_TEMPLATE, eventName: DEFAULT_EVENT_NAME, showPower: false };
  try { return { ...def, ...(JSON.parse(localStorage.getItem(ANN_KEY) || '{}')) }; }
  catch (_) { return def; }
}
function saveAnnPrefs() {
  try {
    localStorage.setItem(ANN_KEY, JSON.stringify({ template: $('#ann-template').value, eventName: $('#ann-event').value, showPower: $('#ann-power').checked }));
  } catch (_) { /* 保存できなくても動作には影響しない */ }
}
function initAnnouncement() {
  const p = loadAnnPrefs();
  $('#ann-template').value = p.template;
  $('#ann-event').value = p.eventName;
  $('#ann-power').checked = p.showPower;
  for (const id of ['#ann-template', '#ann-event', '#ann-power']) {
    $(id).addEventListener('input', () => { saveAnnPrefs(); renderAnnouncement(); });
  }
  $('#ann-datetime').addEventListener('input', (e) => {
    state.dateTime = e.target.value.trim();
    state.dateTimeSource = state.dateTime ? 'manual' : '';
    renderAnnouncement();
  });
  $('#ann-leader').addEventListener('change', (e) => { state.leaderName = e.target.value || null; renderAnnouncement(); });
}
function renderAnnouncement() {
  if (!state.teams.length) return;
  // 開催日時
  const dtInput = $('#ann-datetime');
  if (document.activeElement !== dtInput) dtInput.value = state.dateTime;
  dtInput.classList.toggle('missing', !state.dateTime);
  $('#ann-datetime-note').textContent = state.dateTimeSource === 'ocr' ? '(スクショから読み取り。違っていたら直してください)' : state.dateTime ? '' : '(読み取れませんでした。入力してください)';
  // 本部リーダー: 既定は全体で最も戦力の高い人
  const top = topMember(state.teams);
  const names = state.teams.flatMap((t) => t.members.map((m) => m.name));
  if (state.leaderName && !names.includes(state.leaderName)) state.leaderName = null;
  const leader = state.leaderName || top?.name || '';
  $('#ann-leader').innerHTML = names.map((n) => `<option value="${esc(n)}" ${n === leader ? 'selected' : ''}>${esc(n)}${n === top?.name ? '(最高戦力)' : ''}</option>`).join('');
  $('#ann-text').value = buildAnnouncement(state.teams, {
    template: $('#ann-template').value,
    eventName: $('#ann-event').value.trim() || DEFAULT_EVENT_NAME,
    dateTime: state.dateTime,
    leader,
    showPower: $('#ann-power').checked,
  });
  setStatus('#status-ann', '');
}
$('#btn-ann-reset').addEventListener('click', () => {
  $('#ann-template').value = DEFAULT_TEMPLATE;
  saveAnnPrefs(); renderAnnouncement();
});
$('#btn-ann-regen').addEventListener('click', renderAnnouncement);
$('#btn-copy').addEventListener('click', async () => {
  const ta = $('#ann-text');
  try {
    // クリップボード権限の確認で待たされる環境があるので、時間切れなら選択+copy コマンドに切り替える
    await Promise.race([navigator.clipboard.writeText(ta.value), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1500))]);
  } catch (_) { ta.focus(); ta.select(); document.execCommand('copy'); }
  setStatus('#status-ann', state.dateTime ? 'コピーしました。同盟チャットやメールに貼り付けてください💌' : 'コピーしました。開催日時が未設定なので、貼り付け後に日時を入れてください');
});

/* ---------- 起動 ---------- */
initAnnouncement();
