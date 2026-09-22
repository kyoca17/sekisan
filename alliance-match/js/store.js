// 戦力マスターの永続化(localStorage)と JSON 入出力
const KEY = 'alliance-match:master:v1';
export const SEED_URL = './data/power_master.json';

export function newId() {
  return (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
}

export function emptyMaster() {
  return { version: 1, updatedAt: null, members: [] };
}

export function loadMaster() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const m = JSON.parse(raw);
    if (!m || !Array.isArray(m.members)) return null;
    return m;
  } catch (_) {
    return null;
  }
}

export function saveMaster(master) {
  master.updatedAt = new Date().toISOString();
  localStorage.setItem(KEY, JSON.stringify(master));
  return master;
}

export function clearMaster() {
  localStorage.removeItem(KEY);
}

/** リポジトリ同梱の初期データ(data/power_master.json)を取得。無ければ null */
export async function fetchSeed() {
  try {
    const res = await fetch(SEED_URL, { cache: 'no-store' });
    if (!res.ok) return null;
    const m = await res.json();
    return normalizeMaster(m);
  } catch (_) {
    return null;
  }
}

/** インポートした JSON を内部形式に整える(配列だけの形式も受け付ける) */
export function normalizeMaster(input) {
  const members = Array.isArray(input) ? input : (input?.members ?? []);
  const out = emptyMaster();
  out.updatedAt = input?.updatedAt ?? null;
  for (const m of members) {
    if (!m || !m.name) continue;
    const power = Number(m.power);
    if (!Number.isFinite(power)) continue;
    out.members.push({
      id: m.id || newId(),
      name: String(m.name).trim(),
      power: Math.round(power),
      prevPower: m.prevPower ?? null,
      rank: m.rank ?? null,
      updatedAt: m.updatedAt ?? null,
      note: m.note ?? '',
    });
  }
  return out;
}

export function exportJson(master) {
  const payload = { version: 1, updatedAt: master.updatedAt, members: master.members };
  return JSON.stringify(payload, null, 2);
}

export function downloadText(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
