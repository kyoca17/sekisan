// 名前・戦力の解釈、3人組編成、お知らせ文の生成(純粋関数のみ。ブラウザ/Node両用)

/** 表記ゆれを吸収するために名前を正規化する */
export function normalizeName(s) {
  if (!s) return '';
  return s
    .normalize('NFKC')
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
  return 1 - levenshtein(x, y) / maxLen;
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

/**
 * 3人組(任意サイズ)を編成する。
 * 手順: 戦力降順に並べ、スネーク方式(1→g, g→1, 1→g…)で配布して各組に上位者を1人ずつ置く。
 * その後、各組の先頭(リーダー)は固定したまま、他メンバーの入れ替えで合計戦力のばらつきを減らす。
 * @param {Array<{name:string, power:number}>} members
 * @param {{size?:number, remainder?:'extra'|'short', balance?:boolean}} opts
 *   remainder: 'extra' = 余りは既存グループに追加(4人組ができる) / 'short' = 人数の少ない組を作る(2人組ができる)
 */
export function formTeams(members, opts = {}) {
  const size = Math.max(2, opts.size ?? 3);
  const remainder = opts.remainder ?? 'short';
  const balance = opts.balance ?? true;
  const sorted = [...members]
    .map((m) => ({ ...m, power: m.power ?? 0 }))
    .sort((a, b) => b.power - a.power);
  const n = sorted.length;
  if (n === 0) return [];
  const g = remainder === 'short' ? Math.ceil(n / size) : Math.max(1, Math.floor(n / size));
  const teams = Array.from({ length: g }, () => []);
  let idx = 0, dir = 1, t = 0;
  while (idx < n) {
    teams[t].push(sorted[idx++]);
    if (dir === 1) { if (t === g - 1) dir = -1; else t++; }
    else if (t === 0) dir = 1; else t--;
  }
  if (balance && g > 1) balanceTeams(teams);
  return teams.map((members, i) => ({ no: i + 1, members, total: members.reduce((s, m) => s + m.power, 0) }));
}

function variance(teams) {
  const sums = teams.map((t) => t.reduce((s, m) => s + m.power, 0));
  const mean = sums.reduce((a, b) => a + b, 0) / sums.length;
  return sums.reduce((a, s) => a + (s - mean) ** 2, 0);
}

/** リーダー(各組index 0)以外の入れ替えで分散を最小化(貪欲な局所探索) */
function balanceTeams(teams) {
  let improved = true, guard = 0;
  while (improved && guard++ < 200) {
    improved = false;
    let cur = variance(teams);
    for (let a = 0; a < teams.length; a++) {
      for (let b = a + 1; b < teams.length; b++) {
        for (let i = 1; i < teams[a].length; i++) {
          for (let j = 1; j < teams[b].length; j++) {
            [teams[a][i], teams[b][j]] = [teams[b][j], teams[a][i]];
            const v = variance(teams);
            if (v < cur - 1e-6) { cur = v; improved = true; }
            else [teams[a][i], teams[b][j]] = [teams[b][j], teams[a][i]];
          }
        }
      }
    }
  }
  for (const t of teams) t.sort((x, y) => y.power - x.power);
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

◾️本部リーダー　{本部リーダー}

不明点があれば 同盟チャットで確認してください。
よろしくお願いします！`;

export const DEFAULT_EVENT_NAME = 'クレイジージョイ';

/** 組分け部分の行 */
export function teamsToLines(teams, { showPower = false } = {}) {
  return teams.map((t) => {
    const names = t.members.map((m) => (showPower ? `${m.name}(${formatPowerM(m.power)})` : m.name)).join(' ・ ');
    return `【${t.no}組】${names}` + (showPower ? `　合計 ${formatPowerM(t.total)}` : '');
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
