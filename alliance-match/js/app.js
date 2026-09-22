// 画面制御
import { OcrEngine, loadImage, extractVoteCards, extractDateTime } from './ocr.js?v=9';
import { parsePower, formatPowerM, formTeams, buildAnnouncement, topMember, nameSimilarity, resolveName, learnName, DEFAULT_TEMPLATE, DEFAULT_EVENT_NAME } from './matching.js?v=9';
import { loadNames, saveNames, fetchSeed as fetchNamesSeed, applySeedIfNewer, emptyNames } from './names.js?v=9';

const APP_VERSION = '9'; // 配信キャッシュ対策。公開時は index.html の ?v= と合わせて上げる
const $ = (sel, root = document) => root.querySelector(sel);
/** 要素が無くても落ちないイベント登録(古いHTMLがキャッシュされていても他の機能は動くように) */
const on = (sel, ev, fn) => { const el = $(sel); if (el) el.addEventListener(ev, fn); else console.warn('要素がありません:', sel); };
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
  images: [],        // {id, kind:'vote'|'poll', name, status:'busy'|'done'|'removed'}
  voters: [],        // {id, name, raw, resolved, power, nameConf, powerConf, sources:Set<imageId>}
  names: emptyNames(), // 名前マスター {names:[], aliases:{}}
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
  if (!drop || !input) { console.warn('要素がありません:', dropId, inputId); return; }
  input.addEventListener('change', () => { if (input.files.length) handler(Array.from(input.files)); input.value = ''; });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault(); drop.classList.remove('over');
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
    if (files.length) handler(files);
  });
}

/** サムネイルを追加。✕ でその画像と読み取り結果を取り消せる */
function addThumb(file, kind) {
  const id = newId();
  state.images.push({ id, kind, name: file.name, status: 'busy' });
  const wrap = document.createElement('div');
  wrap.className = 'thumb busy';
  wrap.dataset.id = id;
  const img = document.createElement('img');
  img.src = URL.createObjectURL(file);
  img.alt = file.name;
  img.onload = () => URL.revokeObjectURL(img.src);
  const lbl = document.createElement('span');
  lbl.className = 'lbl';
  lbl.textContent = kind === 'vote' ? '投票メンバー' : '同盟投票';
  const rm = document.createElement('button');
  rm.className = 'rm'; rm.type = 'button'; rm.title = 'この画像を取り消す'; rm.textContent = '✕';
  rm.addEventListener('click', () => removeImage(id));
  wrap.append(img, lbl, rm);
  $('#thumbs-vote').appendChild(wrap);
  return id;
}

function markThumbDone(id) {
  const im = state.images.find((x) => x.id === id);
  if (im && im.status === 'busy') im.status = 'done';
  $(`.thumb[data-id="${id}"]`)?.classList.remove('busy');
}

function isRemoved(id) {
  return state.images.find((x) => x.id === id)?.status === 'removed';
}

/** 画像を取り消し、その画像だけから読み取ったメンバー/日時を消す(処理中なら完了時に結果を捨てる) */
function removeImage(id) {
  const im = state.images.find((x) => x.id === id);
  if (!im) return;
  im.status = 'removed';
  $(`.thumb[data-id="${id}"]`)?.remove();
  if (im.kind === 'vote') {
    state.voters = state.voters.filter((v) => { v.sources.delete(id); return v.sources.size > 0 || v.manual; });
    renderVoters();
    updateVoteState();
    renderNames();
    setStatus('#status-vote', `画像を取り消しました(残り ${state.voters.length} 人)。`);
  } else {
    if (state.dateTimeSource === 'ocr') { state.dateTime = ''; state.dateTimeSource = ''; }
    $('#state-poll').textContent = '';
    setStatus('#status-vote', '同盟投票の画像を取り消しました。');
  }
  renderAnnouncement();
}

function updateVoteState() {
  $('#state-vote').textContent = state.voters.length ? `✔ ${state.voters.length} 人` : '';
}

/* ---------- 投票メンバー読み取り ---------- */
bindDrop('#drop-vote', '#file-vote', async (files) => {
  const jobs = files.map((f) => ({ file: f, id: addThumb(f, 'vote') }));
  try {
    await engine.init((m) => setStatus('#status-vote', m));
    for (const [i, { file, id }] of jobs.entries()) {
      if (isRemoved(id)) continue;
      const prefix = jobs.length > 1 ? `画像 ${i + 1}/${jobs.length}: ` : '';
      const { rows } = await extractVoteCards(engine, file, (m) => setStatus('#status-vote', prefix + m));
      if (isRemoved(id)) continue; // 処理中に取り消された
      for (const r of rows) {
        if (!r.name && r.power == null) continue;
        const resolvedName = resolveName(r.name, state.names).name;
        const dup = state.voters.find((v) => (nameSimilarity(v.name, r.name) >= 0.9 || nameSimilarity(v.name, resolvedName) >= 0.9 || nameSimilarity(v.raw || '', r.name) >= 0.9) && (v.power == null || r.power == null || Math.abs(v.power - r.power) < 2e5));
        if (dup) { dup.sources.add(id); continue; }
        const res = resolveName(r.name, state.names);
        state.voters.push({ id: newId(), name: res.name, raw: r.name, resolved: res.how, power: r.power, nameConf: res.how ? Math.max(r.nameConf, 90) : r.nameConf, powerConf: r.powerConf, sources: new Set([id]) });
      }
      markThumbDone(id);
      renderVoters();
      updateVoteState();
      renderNames();
    }
    renderAnnouncement();
    if (jobs.every((j) => isRemoved(j.id))) return; // すべて取り消された
    setStatus('#status-vote', `${state.voters.length} 人を読み取りました。${state.dateTime ? '' : '同盟投票のスクショも選ぶと開催日時が入ります。'}内容を確認して「組分けを作成」へ進んでください。`);
  } catch (err) {
    console.error(err);
    jobs.forEach((j) => markThumbDone(j.id));
    setStatus('#status-vote', '読み取りに失敗しました: ' + err.message, true);
  }
});

/* ---------- 同盟投票(開催日時)読み取り ---------- */
bindDrop('#drop-poll', '#file-poll', async (files) => {
  const f = files[0];
  // 同盟投票は1枚だけなので、前の画像があれば置き換える
  state.images.filter((x) => x.kind === 'poll' && x.status !== 'removed').forEach((x) => removeImage(x.id));
  const id = addThumb(f, 'poll');
  try {
    await engine.init((m) => setStatus('#status-vote', m));
    setStatus('#status-vote', '開催日時を探しています…');
    const img = await loadImage(f);
    const { found } = await extractDateTime(engine, img);
    markThumbDone(id);
    if (isRemoved(id)) return; // 処理中に取り消された
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
    markThumbDone(id);
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
      <td><input type="text" class="name" data-field="name" value="${esc(v.name)}"><div class="conf">${v.raw && v.raw !== v.name ? `読み取り: ${esc(v.raw)}${v.resolved === 'alias' ? '(辞書)' : v.resolved ? '(自動)' : ''}` : `信頼度 ${v.nameConf ?? '-'}`}</div></td>
      <td><input type="text" class="pow" data-field="power" value="${esc(v.power != null ? formatPowerM(v.power) : '')}"><div class="conf">信頼度 ${v.powerConf ?? '-'}</div></td>
      <td><button class="del" title="除外" data-del>✕</button></td>
    </tr>`;
  }).join('');
  tbody.querySelectorAll('input').forEach((el) => el.addEventListener('change', (e) => {
    const v = state.voters.find((x) => x.id === e.target.closest('tr').dataset.id);
    if (e.target.dataset.field === 'name') {
      const name = e.target.value.trim();
      if (name && v.raw && name !== v.name) {
        // 直した名前を名前マスターに覚える
        state.names = learnName(state.names, v.raw, name);
        saveNames(state.names);
        renderNames();
      }
      v.name = name; v.nameConf = 100; v.resolved = v.raw && v.raw !== name ? 'alias' : v.resolved;
    }
    else { v.power = parsePower(e.target.value); v.powerConf = 100; }
    renderVoters();
  }));
  tbody.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', (e) => {
    const id = e.target.closest('tr').dataset.id;
    state.voters = state.voters.filter((x) => x.id !== id);
    renderVoters();
    updateVoteState();
  }));
}

on('#btn-add-voter', 'click', () => {
  // 空の行を追加して表の中で入力してもらう(ダイアログが使えない環境でも動く)
  const id = newId();
  state.voters.push({ id, name: '', raw: '', resolved: null, power: null, nameConf: 100, powerConf: 100, sources: new Set(), manual: true });
  renderVoters();
  const input = $(`tr[data-id="${id}"] input.name`);
  if (input) input.focus();
});
on('#btn-clear-voters', 'click', () => {
  state.voters = []; state.teams = []; state.leaderName = null;
  state.images.forEach((x) => { x.status = 'removed'; });
  if (state.dateTimeSource === 'ocr') { state.dateTime = ''; state.dateTimeSource = ''; }
  $('#thumbs-vote').innerHTML = ''; $('#state-vote').textContent = ''; $('#state-poll').textContent = '';
  $('#teams').innerHTML = ''; $('#announce-card').hidden = true;
  setStatus('#status-vote', '');
  renderVoters();
});

/* ---------- 組分け ---------- */
function buildTeams() {
  const members = state.voters.map((v) => ({ name: v.name, power: v.power ?? 0 })).filter((m) => m.name);
  const missing = members.filter((m) => !m.power).length;
  state.teams = formTeams(members, { size: parseInt($('#opt-size').value, 10) || 3 });
  renderTeams();
  if (missing) setStatus('#status-vote', `${missing} 人は戦力が不明のため 0 として扱いました。表で戦力を入力すると反映されます。`);
}

function renderTeams() {
  const el = $('#teams');
  el.innerHTML = state.teams.map((t) => `<div class="team">
    <h4>【${esc(t.label)}】 <span>合計 ${formatPowerM(t.total)}</span></h4>
    <ul>${t.members.map((m) => `<li><span>${esc(m.name)}</span><span class="p">${formatPowerM(m.power)}</span></li>`).join('')}</ul>
  </div>`).join('');
  $('#announce-card').hidden = state.teams.length === 0;
  renderAnnouncement();
}

on('#btn-form', 'click', buildTeams);
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
  // 以前のひな形を保存している端末向けの置き換え(本部リーダーの記号を ◾️ から ・ に)
  if (p.template.includes('◾️本部リーダー')) p.template = p.template.replace('◾️本部リーダー', '・本部リーダー');
  $('#ann-template').value = p.template;
  $('#ann-event').value = p.eventName;
  $('#ann-power').checked = p.showPower;
  for (const id of ['#ann-template', '#ann-event', '#ann-power']) {
    on(id, 'input', () => { saveAnnPrefs(); renderAnnouncement(); });
  }
  on('#ann-datetime', 'input', (e) => {
    state.dateTime = e.target.value.trim();
    state.dateTimeSource = state.dateTime ? 'manual' : '';
    renderAnnouncement();
  });
  on('#ann-leader', 'change', (e) => { state.leaderName = e.target.value || null; renderAnnouncement(); });
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
on('#btn-ann-reset', 'click', () => {
  $('#ann-template').value = DEFAULT_TEMPLATE;
  saveAnnPrefs(); renderAnnouncement();
});
on('#btn-ann-regen', 'click', renderAnnouncement);
on('#btn-copy', 'click', async () => {
  const ta = $('#ann-text');
  try {
    // クリップボード権限の確認で待たされる環境があるので、時間切れなら選択+copy コマンドに切り替える
    await Promise.race([navigator.clipboard.writeText(ta.value), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1500))]);
  } catch (_) { ta.focus(); ta.select(); document.execCommand('copy'); }
  setStatus('#status-ann', state.dateTime ? 'コピーしました。同盟チャットやメールに貼り付けてください💌' : 'コピーしました。開催日時が未設定なので、貼り付け後に日時を入れてください');
});

/* ---------- 名前マスター ---------- */
async function initNames() {
  let m = loadNames() || emptyNames();
  // 同梱データ(data/names.json)が端末の保存分より新しければ追記する
  const seed = await fetchNamesSeed();
  const { master, applied } = applySeedIfNewer(m, seed);
  if (applied) saveNames(master);
  state.names = master;
  renderNames();
  reresolveVoters();
}

function persistNames() {
  saveNames(state.names);
  renderNames();
}

/** マスターが変わったら、手で直していない読み取り名を解決し直す */
function reresolveVoters() {
  for (const v of state.voters) {
    if (!v.raw || v.nameConf === 100) continue;
    const res = resolveName(v.raw, state.names);
    v.name = res.name; v.resolved = res.how;
  }
  renderVoters();
  renderAnnouncement();
}

function renderNames() {
  // 今回読み取った名前の一覧(読み取り → 正しい名前)。それ以外の管理画面は出さない
  const rows = state.voters.filter((v) => v.raw);
  $('#learn-empty').hidden = rows.length > 0;
  $('#btn-learn-done').hidden = rows.length === 0;
  $('#learn-table tbody').innerHTML = rows.map((v) => `<tr data-id="${esc(v.id)}">
    <td class="raw">${esc(v.raw)}</td>
    <td><input type="text" class="name" data-field="correct" value="${esc(v.name)}" list="names-datalist"></td>
  </tr>`).join('');
  // 入力候補(登録済みの名前)
  let dl = $('#names-datalist');
  if (!dl) { dl = document.createElement('datalist'); dl.id = 'names-datalist'; document.body.appendChild(dl); }
  dl.innerHTML = [...state.names.names].sort((a, b) => a.localeCompare(b, 'ja')).map((n) => `<option value="${esc(n)}"></option>`).join('');
}

on('#btn-learn-done', 'click', () => {
  let changed = 0;
  $('#learn-table tbody').querySelectorAll('tr').forEach((tr) => {
    const v = state.voters.find((x) => x.id === tr.dataset.id);
    const correct = tr.querySelector('[data-field=correct]').value.trim();
    if (!v || !correct || correct === v.name) return;
    state.names = learnName(state.names, v.raw, correct);
    v.name = correct; v.nameConf = 100; v.resolved = v.raw !== correct ? 'alias' : 'exact';
    changed++;
  });
  if (changed) saveNames(state.names);
  renderNames();
  renderVoters();
  renderAnnouncement();
  setStatus('#status-learn', changed ? `${changed} 件を修正しました。学習したので次回から正しく読み取ります。` : '修正はありませんでした。');
  if (changed) { switchTab('match'); setStatus('#status-vote', `名前を ${changed} 件修正しました。`); }
});

/* ---------- 起動 ---------- */
initNames();
console.info('alliance-match v' + APP_VERSION);
initAnnouncement();
