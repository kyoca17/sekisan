// 名前・戦力の解釈、3人組編成、お知らせ文の生成(純粋関数のみ。ブラウザ/Node両用)

/** 表記ゆれを吸収するために名前を正規化する */
export function normalizeName(s) {
  if (!s) return '';
  return s
    .normalize('NFKC')
    // 濁点・半濁点はOCRで落ちたり付いたりしやすいので無視する(け/げ など)
    .normalize('NFD').replace(/[\u3099\u309A]/g, '').normalize('NFC')
    .toLowerCase()
    .replace(/[\s　]+/g, '')
    .replace(/[\-‐‑–—−ｰ―]/g, 'ー')
    .replace(/[|｜「」『』\[\]()（）【】<>《》〈〉"'`.,、。・:;!?！？~〜_=+*#&%$@^]/g, '');
}

/** レーベンシュタイン距離 */
export function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

/** 0〜1 の名前類似度(1が完全一致)。複数枚のスクショで同じ人を除くために使う */
export function nameSimilarity(a, b) {
  const x = normalizeName(a), y = normalizeName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const maxLen = Math.max(x.length, y.length);
  const lev = 1 - levenshtein(x, y) / maxLen;
  const lcs = lcsLength(x, y) / maxLen;
  return Math.max(lev, lcs);
}

/** 最長共通部分列の長さ */
function lcsLength(a, b) {
  const m = a.length, n = b.length;
  if (!m || !n) return 0;
  let prev = new Array(n + 1).fill(0);
  let cur = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    [prev, cur] = [cur, prev];
    cur.fill(0);
  }
  return prev[n];
}

/** "38.8M" / "38,870,574" / "4.0K" などを数値(戦力)に変換。解釈できなければ null */
export function parsePower(text) {
  if (text == null) return null;
  let s = String(text).normalize('NFKC').trim().toUpperCase();
  s = s.replace(/[^0-9.,KMB]/g, '');
  if (!s) return null;
  const unit = /[KMB]$/.exec(s)?.[0];
  if (unit) {
    const body = s.slice(0, -1).replace(/[KMB]/g, '').replace(',', '.');
    const num = parseFloat(body);
    if (Number.isNaN(num)) return null;
    const mult = unit === 'K' ? 1e3 : unit === 'M' ? 1e6 : 1e9;
    return Math.round(num * mult);
  }
  const digits = s.replace(/[^0-9]/g, '');
  return digits ? parseInt(digits, 10) : null;
}

/** 戦力を "38.9M" 形式に */
export function formatPowerM(p) {
  if (p == null || Number.isNaN(p)) return '-';
  if (p >= 1e9) return (p / 1e9).toFixed(2) + 'B';
  if (p >= 1e6) return (p / 1e6).toFixed(1) + 'M';
  if (p >= 1e3) return (p / 1e3).toFixed(1) + 'K';
  return String(p);
}

/** チーム名: A, B, C, … Z, AA, AB, … */
export function teamLabel(index) {
  let n = index, out = '';
  do { out = String.fromCharCode(65 + (n % 26)) + out; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return out;
}

/**
 * 3人組(任意サイズ)を編成する。戦力の近い人同士で組み、A が最も強いチームになる。
 * 手順: 戦力降順に並べ、上から順に size 人ずつ区切る。
 * 人数が割り切れないときは人数の少ない組は作らず、余った人を弱い側の組から順に1人ずつ加える(4人組になる)。
 * @param {Array<{name:string, power:number}>} members
 * @param {{size?:number}} opts
 * @returns {Array<{no:number, label:string, members:Array, total:number}>}
 */
export function formTeams(members, opts = {}) {
  const size = Math.max(2, opts.size ?? 3);
  const sorted = [...members]
    .map((m) => ({ ...m, power: m.power ?? 0 }))
    .sort((a, b) => b.power - a.power);
  const n = sorted.length;
  if (n === 0) return [];
  const g = Math.max(1, Math.floor(n / size));
  const sizes = Array.from({ length: g }, () => size);
  let extra = n - g * size;
  for (let i = g - 1; extra > 0; i = (i - 1 + g) % g, extra--) sizes[i]++;
  const teams = [];
  let idx = 0;
  for (let i = 0; i < g; i++) {
    const team = sorted.slice(idx, idx + sizes[i]);
    idx += sizes[i];
    teams.push({ no: i + 1, label: teamLabel(i), members: team, total: team.reduce((s, m) => s + m.power, 0) });
  }
  return teams;
}

/* ---------- 日時 ---------- */

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

/**
 * OCRした文章から開催日時を探す。
 * 対応: "24日(木)22:30", "9/24(木) 22:30", "9月24日 22:30", "09/24 22時30分"
 * 月が無い表記は、今日以降で最初に来るその日(曜日が合う日を優先)とみなす。
 * @returns {{month:number, day:number, hour:number, minute:number, weekday:string, text:string}|null}
 */
export function findDateTime(text, now = new Date()) {
  if (!text) return null;
  const s = String(text).normalize('NFKC').replace(/[\s\u3000]+/g, '');
  // 月あり
  const withMonth = /(\d{1,2})[\/月](\d{1,2})日?(?:[(（]([月火水木金土日])[)）])?(\d{1,2})[:：時](\d{2})分?/g;
  let m;
  while ((m = withMonth.exec(s))) {
    const r = makeDateTime({ month: +m[1], day: +m[2], weekday: m[3], hour: +m[4], minute: +m[5] }, now);
    if (r) return r;
  }
  // 日だけ("24日(木)22:30")。OCRで「日」が H に化けることがあるので許容する
  const dayOnly = /(\d{1,2})[日H](?:[(（]([月火水木金土日A-Za-z])[)）])?(\d{1,2})[:：時](\d{2})分?/g;
  while ((m = dayOnly.exec(s))) {
    const r = makeDateTime({ day: +m[1], weekday: m[2], hour: +m[3], minute: +m[4] }, now);
    if (r) return r;
  }
  return null;
}

function makeDateTime({ month, day, weekday, hour, minute }, now) {
  if (weekday && !WEEKDAYS.includes(weekday)) weekday = undefined; // 化けた曜日は無視して日付から補う
  if (day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  if (month != null && (month < 1 || month > 12)) return null;
  const d = month != null ? resolveYear(month, day, now) : inferMonth(day, weekday, now);
  if (!d) return null;
  const wd = weekday || WEEKDAYS[d.getDay()];
  const out = { month: d.getMonth() + 1, day: d.getDate(), hour, minute, weekday: wd };
  return { ...out, text: formatDateTime(out) };
}

/** 月日が分かっている場合: 今日以降で最初に来るその月日 */
function resolveYear(month, day, now) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let d = new Date(now.getFullYear(), month - 1, day);
  if (d < today) d = new Date(now.getFullYear() + 1, month - 1, day);
  return d.getDate() === day ? d : null;
}

/** 日だけ分かっている場合: 今日以降12か月以内で、曜日が合う最初のその日(合う日が無ければ最初のその日) */
export function inferMonth(day, weekday, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let first = null;
  for (let i = 0; i < 13; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, day);
    if (d.getDate() !== day || d < today) continue; // その月に存在しない日(2/30など)や過去はスキップ
    if (!first) first = d;
    if (!weekday || WEEKDAYS[d.getDay()] === weekday) return d;
  }
  return first;
}

/** 年を補って曜日を求める(今日以降で最初に来るその月日) */
export function weekdayFor(month, day, now = new Date()) {
  const d = resolveYear(month, day, now);
  return d ? WEEKDAYS[d.getDay()] : '';
}

export function formatDateTime({ month, day, hour, minute, weekday }) {
  const w = weekday ? `(${weekday})` : '';
  return `${month}/${day}${w}${hour}:${String(minute).padStart(2, '0')}`;
}

/* ---------- お知らせ文 ---------- */

export const DEFAULT_TEMPLATE = `【{イベント名}】チーム発表
みなさん、投票ありがとうございました！
次回の開催は{日時}からです。
事前準備のため、10分前にはオンラインになってもらえると助かります。

今回の3人組の組み合わせが決まったので、お知らせします。

{組分け}

・本部リーダー　{本部リーダー}

不明点があれば 同盟チャットで確認してください。
よろしくお願いします！`;

export const DEFAULT_EVENT_NAME = 'クレイジージョイ';

/** 組分け部分の行 */
export function teamsToLines(teams, { showPower = false } = {}) {
  return teams.map((t) => {
    const names = t.members.map((m) => (showPower ? `${m.name}(${formatPowerM(m.power)})` : m.name)).join(' ・ ');
    return `【${t.label}】${names}` + (showPower ? `　合計 ${formatPowerM(t.total)}` : '');
  });
}

/**
 * お知らせ文を作る。テンプレートの {イベント名} {日時} {組分け} {本部リーダー} を差し替える。
 * @param {Array} teams formTeams の結果
 * @param {{template?:string, eventName?:string, dateTime?:string, leader?:string, showPower?:boolean}} opts
 */
export function buildAnnouncement(teams, opts = {}) {
  const template = opts.template ?? DEFAULT_TEMPLATE;
  const leader = opts.leader ?? topMember(teams)?.name ?? '';
  return template
    .replaceAll('{イベント名}', opts.eventName ?? DEFAULT_EVENT_NAME)
    .replaceAll('{日時}', opts.dateTime || '（日時未設定）')
    .replaceAll('{組分け}', teamsToLines(teams, { showPower: !!opts.showPower }).join('\n'))
    .replaceAll('{本部リーダー}', leader)
    .trim() + '\n';
}

/** 全体で最も戦力の高いメンバー */
export function topMember(teams) {
  let best = null;
  for (const t of teams) for (const m of t.members) if (!best || m.power > best.power) best = m;
  return best;
}

/* ---------- 名前マスター(読み替え辞書) ---------- */

/**
 * OCRで読んだ名前を、登録済みの正しい名前に解決する。
 * 1) 読み替え辞書(正規化した読み取り文字列 → 正しい名前)に完全一致
 * 2) 登録名との類似度が高く(0.6以上)、2位と差があれば、その登録名
 * @param {string} raw OCR結果
 * @param {{names:string[], aliases:Record<string,string>}} master
 * @returns {{name:string, how:'alias'|'fuzzy'|'exact'|null, score:number}}
 */
export function resolveName(raw, master) {
  const key = normalizeName(raw);
  if (!key) return { name: raw, how: null, score: 0 };
  const aliases = master?.aliases || {};
  if (aliases[key]) return { name: aliases[key], how: 'alias', score: 1 };
  const names = master?.names || [];
  const exact = names.find((n) => normalizeName(n) === key);
  if (exact) return { name: exact, how: 'exact', score: 1 };
  const scored = names.map((n) => ({ n, s: nameSimilarity(raw, n) })).sort((a, b) => b.s - a.s);
  const best = scored[0], second = scored[1];
  if (best && best.s >= 0.6 && (!second || second.s <= best.s - 0.1)) return { name: best.n, how: 'fuzzy', score: best.s };
  return { name: raw, how: null, score: best ? best.s : 0 };
}

/** 読み替え辞書に登録する(正しい名前も登録名一覧に加える)。同じ内容なら変更なし */
export function learnName(master, raw, correct) {
  const key = normalizeName(raw);
  const name = (correct || '').trim();
  if (!name) return master;
  const names = master.names.includes(name) ? master.names : [...master.names, name];
  const aliases = { ...master.aliases };
  if (key && key !== normalizeName(name)) aliases[key] = name;
  return { ...master, names, aliases };
}
