// 名前マスター(正しい名前の一覧と、OCRの読み取り → 正しい名前の読み替え辞書)の保存・読込
const KEY = 'alliance-match:names:v1';
export const SEED_URL = './data/names.json';

export function emptyNames() {
  return { version: 1, updatedAt: null, seedVersion: 0, names: [], aliases: {} };
}

export function loadNames() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    return normalizeNames(JSON.parse(raw));
  } catch (_) {
    return null;
  }
}

export function saveNames(master) {
  master.updatedAt = new Date().toISOString();
  try { localStorage.setItem(KEY, JSON.stringify(master)); } catch (_) { /* 保存不可でも動作は続ける */ }
  return master;
}

export function clearNames() {
  try { localStorage.removeItem(KEY); } catch (_) { /* noop */ }
}

/** 同梱の初期データ(data/names.json)。無ければ null */
export async function fetchSeed() {
  try {
    const res = await fetch(SEED_URL + '?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return null;
    return normalizeNames(await res.json());
  } catch (_) {
    return null;
  }
}

/** 配列だけ / {names, aliases} のどちらの形式も受け付けて内部形式に整える */
export function normalizeNames(input) {
  const out = emptyNames();
  const names = Array.isArray(input) ? input : (input?.names ?? []);
  for (const n of names) { const s = String(n ?? '').trim(); if (s && !out.names.includes(s)) out.names.push(s); }
  const aliases = (!Array.isArray(input) && input?.aliases && typeof input.aliases === 'object') ? input.aliases : {};
  for (const [k, v] of Object.entries(aliases)) { const s = String(v ?? '').trim(); if (k && s) out.aliases[k] = s; }
  out.updatedAt = (!Array.isArray(input) && input?.updatedAt) || null;
  out.seedVersion = (!Array.isArray(input) && Number(input?.seedVersion)) || 0;
  return out;
}

/** 2つのマスターを合成(b が優先) */
export function mergeNames(a, b) {
  const out = emptyNames();
  for (const n of [...a.names, ...b.names]) if (!out.names.includes(n)) out.names.push(n);
  out.aliases = { ...a.aliases, ...b.aliases };
  out.seedVersion = Math.max(a.seedVersion || 0, b.seedVersion || 0);
  return out;
}

/** 同梱データが端末の保存分より新しければ追記する(端末側の登録を優先) */
export function applySeedIfNewer(current, seed) {
  if (!seed || (seed.seedVersion || 0) <= (current.seedVersion || 0)) return { master: current, applied: false };
  const merged = mergeNames(seed, current); // current が後勝ち
  merged.seedVersion = seed.seedVersion;
  return { master: merged, applied: true };
}

export function exportJson(master) {
  return JSON.stringify({ version: 1, seedVersion: master.seedVersion || 0, updatedAt: master.updatedAt, names: master.names, aliases: master.aliases }, null, 2);
}
