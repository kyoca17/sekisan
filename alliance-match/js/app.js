// 画面制御
import { OcrEngine, extractRankRows, extractVoteCards } from './ocr.js';
import { parsePower, formatPowerM, formatPowerFull, matchVoterToMaster, matchRankRowToMaster, formTeams, teamsToText, nameSimilarity } from './matching.js';
import { loadMaster, saveMaster, clearMaster, fetchSeed, normalizeMaster, exportJson, downloadText, emptyMaster, newId } from './store.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ?ocr=local を付けると ./vendor 配下のファイル(オフライン用)を使う
const params = new URLSearchParams(location.search);
const ocrPaths = params.get('ocr') === 'local'
  ? {
      workerPath: new URL('./vendor/worker.min.js', location.href).href,
      corePath: new URL('./vendor/', location.href).href,
      langPath: new URL('./vendor/lang', location.href).href,
      gzip: true,
    }
  : {};
const engine = new OcrEngine(ocrPaths);

const state = {
  master: emptyMaster(),
  voters: [],   // {id, name, power, matchId, auto, nameConf, powerConf}
  pending: [],  // {id, name, power, rawPower, nameConf, powerConf, matchId, action:'update'|'new'|'skip', source}
  teams: [],
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

function findMember(id) { return state.master.members.find((m) => m.id === id) || null; }

/* ---------- マスター ---------- */
async function initMaster() {
  let m = loadMaster();
  if (!m) {
    m = await fetchSeed();
    if (m) saveMaster(m);
  }
  state.master = m || emptyMaster();
  renderMaster();
}

function persistMaster() {
  saveMaster(state.master);
  renderMaster();
}

function renderMaster() {
  const q = ($('#master-search').value || '').trim().toLowerCase();
  const members = [...state.master.members].sort((a, b) => b.power - a.power);
  const tbody = $('#master-table tbody');
  const rows = members.filter((m) => !q || m.name.toLowerCase().includes(q));
  tbody.innerHTML = rows.map((m, i) => {
    const stale = m.updatedAt && (Date.now() - new Date(m.updatedAt).getTime()) > 14 * 864e5;
    const diff = m.prevPower != null ? m.power - m.prevPower : null;
    return `<tr data-id="${esc(m.id)}">
      <td>${members.indexOf(m) + 1}</td>
      <td><input type="text" class="name" data-field="name" value="${esc(m.name)}"></td>
      <td><input type="text" class="pow" data-field="power" value="${esc(formatPowerFull(m.power))}">
        ${diff != null && diff !== 0 ? `<span class="conf ${diff > 0 ? 'diff-up' : 'diff-down'}">${diff > 0 ? '+' : ''}${formatPowerM(diff)}</span>` : ''}</td>
      <td class="conf">${m.updatedAt ? new Date(m.updatedAt).toLocaleDateString('ja-JP') : '-'}${stale ? ' <span class="tag new">古い</span>' : ''}</td>
      <td><button class="del" title="削除" data-del>✕</button></td>
    </tr>`;
  }).join('');
  $('#master-count').textContent = state.master.members.length;
  $('#master-meta').textContent = state.master.updatedAt ? `最終更新 ${new Date(state.master.updatedAt).toLocaleString('ja-JP')}` : '';

  tbody.querySelectorAll('input').forEach((inp) => inp.addEventListener('change', (e) => {
    const tr = e.target.closest('tr');
    const m = findMember(tr.dataset.id);
    if (!m) return;
    if (e.target.dataset.field === 'name') m.name = e.target.value.trim() || m.name;
    else {
      const p = parsePower(e.target.value);
      if (p != null) m.power = p;
    }
    m.updatedAt = new Date().toISOString();
    persistMaster();
    refreshVoterMatches();
  }));
  tbody.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    const m = findMember(tr.dataset.id);
    if (m && confirm(`「${m.name}」をマスターから削除しますか?`)) {
      state.master.members = state.master.members.filter((x) => x.id !== m.id);
      persistMaster();
      refreshVoterMatches();
    }
  }));
}

$('#master-search').addEventListener('input', renderMaster);

$('#btn-add-member').addEventListener('click', () => {
  const name = prompt('名前');
  if (!name) return;
  const power = parsePower(prompt('戦力(例: 12,345,678 または 12.3M)') || '');
  if (power == null) { alert('戦力を読み取れませんでした'); return; }
  state.master.members.push({ id: newId(), name: name.trim(), power, prevPower: null, rank: null, updatedAt: new Date().toISOString(), note: '' });
  persistMaster();
  refreshVoterMatches();
});

$('#btn-export').addEventListener('click', () => {
  downloadText(`power_master_${new Date().toISOString().slice(0, 10)}.json`, exportJson(state.master));
});

$('#file-import').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const m = normalizeMaster(JSON.parse(await file.text()));
    if (!m.members.length) throw new Error('メンバーが含まれていません');
    const mode = state.master.members.length
      ? (confirm(`${m.members.length} 人を読み込みます。\n「OK」= 既存とマージ(名前が同じ人は上書き)\n「キャンセル」= 既存を置き換え`) ? 'merge' : 'replace')
      : 'replace';
    if (mode === 'replace') state.master = m;
    else {
      for (const im of m.members) {
        const ex = state.master.members.find((x) => nameSimilarity(x.name, im.name) === 1);
        if (ex) Object.assign(ex, { power: im.power, prevPower: ex.power, updatedAt: im.updatedAt || new Date().toISOString() });
        else state.master.members.push(im);
      }
    }
    persistMaster();
    refreshVoterMatches();
  } catch (err) {
    alert('JSONを読み込めませんでした: ' + err.message);
  }
});

$('#btn-seed').addEventListener('click', async () => {
  const seed = await fetchSeed();
  if (!seed) { alert('同梱データ(data/power_master.json)を取得できませんでした'); return; }
  if (!confirm(`同梱データ(${seed.members.length} 人)で置き換えますか? 現在のマスターは失われます。`)) return;
  state.master = seed;
  persistMaster();
  refreshVoterMatches();
});

$('#btn-clear-master').addEventListener('click', () => {
  if (!confirm('マスターを全削除しますか?')) return;
  clearMaster();
  state.master = emptyMaster();
  renderMaster();
  refreshVoterMatches();
});

/* ---------- ランキング取り込み ---------- */
bindDrop('#drop-rank', '#file-rank', async (files) => {
  $('#thumbs-rank').innerHTML = '';
  files.forEach((f) => addThumb('#thumbs-rank', f));
  try {
    await engine.init((m) => setStatus('#status-rank', m));
    const got = [];
    for (const [i, f] of files.entries()) {
      const { rows } = await extractRankRows(engine, f, (m) => setStatus('#status-rank', `画像 ${i + 1}/${files.length}: ${m}`));
      for (const r of rows) got.push({ ...r, source: f.name });
    }
    // 画像間の重複(同じ人が2枚に写っている)を除く: 戦力が一致、または名前がほぼ同じ
    const uniq = [];
    for (const r of got) {
      if (!r.name && r.power == null) continue;
      const dup = uniq.find((u) => (u.power != null && u.power === r.power) || (r.name && nameSimilarity(u.name, r.name) >= 0.9));
      if (dup) { if (r.nameConf > dup.nameConf) dup.name = r.name; continue; }
      uniq.push(r);
    }
    state.pending = uniq.map((r) => {
      const m = matchRankRowToMaster(r, state.master.members);
      return {
        id: newId(), name: r.name, power: r.power, rawPower: r.rawPower, nameConf: r.nameConf, powerConf: r.powerConf,
        matchId: m.entry?.id ?? null,
        action: r.power == null ? 'skip' : (m.entry ? 'update' : 'new'),
      };
    });
    setStatus('#status-rank', `${uniq.length} 人を読み取りました。内容を確認して「マスターに反映」を押してください。`);
    renderPending();
  } catch (err) {
    console.error(err);
    setStatus('#status-rank', '読み取りに失敗しました: ' + err.message, true);
  }
});

function renderPending() {
  const card = $('#pending-card');
  card.hidden = state.pending.length === 0;
  const tbody = $('#pending-table tbody');
  const options = (sel) => `<option value="">(新規)</option>` + [...state.master.members].sort((a, b) => a.name.localeCompare(b.name, 'ja'))
    .map((m) => `<option value="${esc(m.id)}" ${m.id === sel ? 'selected' : ''}>${esc(m.name)} (${formatPowerM(m.power)})</option>`).join('');
  tbody.innerHTML = state.pending.map((p) => {
    const m = p.matchId ? findMember(p.matchId) : null;
    const diff = m && p.power != null ? p.power - m.power : null;
    const warn = p.power == null || p.nameConf < 60 || p.powerConf < 60;
    return `<tr data-id="${esc(p.id)}" class="${warn ? 'warn' : ''}">
      <td><select data-field="action">
        <option value="update" ${p.action === 'update' ? 'selected' : ''} ${m ? '' : 'disabled'}>更新</option>
        <option value="new" ${p.action === 'new' ? 'selected' : ''}>新規</option>
        <option value="skip" ${p.action === 'skip' ? 'selected' : ''}>スキップ</option></select></td>
      <td><input type="text" class="name" data-field="name" value="${esc(p.name)}"><div class="conf">信頼度 ${p.nameConf}</div></td>
      <td><input type="text" class="pow" data-field="power" value="${esc(p.power != null ? formatPowerFull(p.power) : p.rawPower)}"><div class="conf">信頼度 ${p.powerConf}</div></td>
      <td><select data-field="matchId">${options(p.matchId)}</select></td>
      <td>${diff == null ? '' : `<span class="${diff > 0 ? 'diff-up' : diff < 0 ? 'diff-down' : ''}">${diff > 0 ? '+' : ''}${formatPowerM(diff)}</span>`}</td>
    </tr>`;
  }).join('');
  tbody.querySelectorAll('select,input').forEach((el) => el.addEventListener('change', (e) => {
    const p = state.pending.find((x) => x.id === e.target.closest('tr').dataset.id);
    const f = e.target.dataset.field;
    if (f === 'name') p.name = e.target.value.trim();
    else if (f === 'power') p.power = parsePower(e.target.value);
    else if (f === 'matchId') { p.matchId = e.target.value || null; p.action = p.matchId ? 'update' : 'new'; }
    else if (f === 'action') p.action = e.target.value;
    renderPending();
  }));
}

$('#btn-apply').addEventListener('click', () => {
  const now = new Date().toISOString();
  let updated = 0, added = 0;
  for (const p of state.pending) {
    if (p.action === 'skip' || p.power == null) continue;
    if (p.action === 'update' && p.matchId) {
      const m = findMember(p.matchId);
      if (!m) continue;
      if (m.power !== p.power) { m.prevPower = m.power; m.power = p.power; }
      // 名前はマスター側を正とする(OCRの化けを持ち込まない)。ただし手で書き換えた高信頼の名前は採用
      if (p.name && p.nameConf >= 90 && nameSimilarity(p.name, m.name) < 1) m.name = p.name;
      m.updatedAt = now; updated++;
    } else if (p.action === 'new' && p.name) {
      state.master.members.push({ id: newId(), name: p.name, power: p.power, prevPower: null, rank: null, updatedAt: now, note: '' });
      added++;
    }
  }
  state.pending = [];
  renderPending();
  persistMaster();
  refreshVoterMatches();
  setStatus('#status-rank', `反映しました(更新 ${updated} 人 / 追加 ${added} 人)`);
});
$('#btn-discard').addEventListener('click', () => { state.pending = []; renderPending(); setStatus('#status-rank', ''); });

/* ---------- 投票メンバー読み取り ---------- */
bindDrop('#drop-vote', '#file-vote', async (files) => {
  files.forEach((f) => addThumb('#thumbs-vote', f));
  try {
    await engine.init((m) => setStatus('#status-vote', m));
    for (const [i, f] of files.entries()) {
      const { rows } = await extractVoteCards(engine, f, (m) => setStatus('#status-vote', `画像 ${i + 1}/${files.length}: ${m}`));
      for (const r of rows) {
        if (!r.name && r.power == null) continue;
        const dup = state.voters.find((v) => nameSimilarity(v.name, r.name) >= 0.9 && (v.power == null || r.power == null || Math.abs(v.power - r.power) < 2e5));
        if (dup) continue;
        state.voters.push({ id: newId(), name: r.name, power: r.power, nameConf: r.nameConf, powerConf: r.powerConf, matchId: null, auto: true });
      }
    }
    refreshVoterMatches();
    setStatus('#status-vote', `${state.voters.length} 人を読み取りました。内容を確認して「組分けを作成」へ進んでください。`);
  } catch (err) {
    console.error(err);
    setStatus('#status-vote', '読み取りに失敗しました: ' + err.message, true);
  }
});

function refreshVoterMatches() {
  for (const v of state.voters) {
    if (!v.auto) { if (v.matchId && !findMember(v.matchId)) { v.matchId = null; v.auto = true; } else continue; }
    const m = matchVoterToMaster({ name: v.name, power: v.power }, state.master.members);
    v.matchId = m.entry?.id ?? null;
    v.weak = !!m.weak;
  }
  renderVoters();
}

function effectivePower(v) {
  const m = v.matchId ? findMember(v.matchId) : null;
  return m ? m.power : v.power;
}
function effectiveName(v) {
  const m = v.matchId ? findMember(v.matchId) : null;
  return m ? m.name : v.name;
}

function renderVoters() {
  $('#voters-card').hidden = state.voters.length === 0;
  $('#teams-card').hidden = state.voters.length === 0;
  const tbody = $('#voters-table tbody');
  const sortedMaster = [...state.master.members].sort((a, b) => b.power - a.power);
  tbody.innerHTML = state.voters.map((v, i) => {
    const m = v.matchId ? findMember(v.matchId) : null;
    const warn = v.weak || (!m && (v.nameConf < 60 || v.power == null)) || (m && v.power != null && Math.abs(m.power - v.power) > Math.max(2e5, m.power * 0.1));
    const opts = `<option value="">(未登録: 読み取り値を使う)</option>` + sortedMaster
      .map((x) => `<option value="${esc(x.id)}" ${x.id === v.matchId ? 'selected' : ''}>${esc(x.name)} (${formatPowerM(x.power)})</option>`).join('');
    return `<tr data-id="${esc(v.id)}" class="${warn ? 'warn' : m ? 'ok' : ''}">
      <td>${i + 1}</td>
      <td><input type="text" class="name" data-field="name" value="${esc(v.name)}"><div class="conf">信頼度 ${v.nameConf ?? '-'}</div></td>
      <td><input type="text" class="pow" data-field="power" value="${esc(v.power != null ? formatPowerM(v.power) : '')}"><div class="conf">信頼度 ${v.powerConf ?? '-'}</div></td>
      <td><select data-field="matchId">${opts}</select></td>
      <td><b>${formatPowerM(effectivePower(v))}</b>${m ? `<div class="conf">${formatPowerFull(m.power)}${v.weak ? ' <span class="tag new">戦力一致で推定</span>' : ''}</div>` : '<div class="conf">読み取り値</div>'}</td>
      <td><button class="del" title="除外" data-del>✕</button></td>
    </tr>`;
  }).join('');
  tbody.querySelectorAll('select,input').forEach((el) => el.addEventListener('change', (e) => {
    const v = state.voters.find((x) => x.id === e.target.closest('tr').dataset.id);
    const f = e.target.dataset.field;
    if (f === 'name') { v.name = e.target.value.trim(); v.nameConf = 100; v.auto = true; }
    else if (f === 'power') { v.power = parsePower(e.target.value); v.powerConf = 100; v.auto = true; }
    else if (f === 'matchId') { v.matchId = e.target.value || null; v.auto = false; }
    refreshVoterMatches();
  }));
  tbody.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', (e) => {
    const id = e.target.closest('tr').dataset.id;
    state.voters = state.voters.filter((x) => x.id !== id);
    renderVoters();
  }));
}

$('#btn-add-voter').addEventListener('click', () => {
  const name = prompt('名前');
  if (!name) return;
  state.voters.push({ id: newId(), name: name.trim(), power: null, nameConf: 100, powerConf: 100, matchId: null, auto: true });
  refreshVoterMatches();
});
$('#btn-clear-voters').addEventListener('click', () => {
  state.voters = []; state.teams = [];
  $('#thumbs-vote').innerHTML = '';
  $('#teams').innerHTML = ''; $('#teams-actions').hidden = true; $('#teams-text').hidden = true;
  setStatus('#status-vote', '');
  renderVoters();
});

/* ---------- 組分け ---------- */
function buildTeams() {
  const members = state.voters
    .map((v) => ({ name: effectiveName(v), power: effectivePower(v) ?? 0, registered: !!v.matchId }))
    .filter((m) => m.name);
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
    <ul>${t.members.map((m, i) => `<li class="${i === 0 ? 'leader' : ''}"><span>${esc(m.name)}${m.registered ? '' : ' <span class="tag">未登録</span>'}</span><span class="p">${formatPowerM(m.power)}</span></li>`).join('')}</ul>
  </div>`).join('');
  const ta = $('#teams-text');
  ta.value = teamsToText(state.teams);
  ta.hidden = state.teams.length === 0;
  $('#teams-actions').hidden = state.teams.length === 0;
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
$('#btn-copy').addEventListener('click', async () => {
  const text = $('#teams-text').value;
  try { await navigator.clipboard.writeText(text); setStatus('#status-vote', 'コピーしました'); }
  catch (_) { $('#teams-text').select(); document.execCommand('copy'); setStatus('#status-vote', 'コピーしました'); }
});

/* ---------- 起動 ---------- */
initMaster();
