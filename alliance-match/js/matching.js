// 名前の正規化・類似度・マスター照合・3人組編成のロジック(純粋関数のみ。ブラウザ/Node両用)

/** 表記ゆれを吸収するために名前を正規化する */
export function normalizeName(s) {
  if (!s) return '';
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[\-\u2010\u2011\u2013\u2014\u2212\uFF70\u2015]/g, 'ー')
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

/** 最長共通部分列の長さ */
function lcsLength(a, b) {
  const m = a.length, n = b.length;
  if (!m || !n) return 0;
  let prev = new Array(n + 1).fill(0);
  let cur = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    [prev, cur] = [cur, prev];
    cur.fill(0);
  }
  return prev[n];
}

/** 0〜1 の名前類似度(1が完全一致)。OCRの文字化けに強いように編集距離とLCSを併用 */
export function nameSimilarity(a, b) {
  const x = normalizeName(a), y = normalizeName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const maxLen = Math.max(x.length, y.length);
  const lev = 1 - levenshtein(x, y) / maxLen;
  const lcs = lcsLength(x, y) / maxLen;
  let sim = Math.max(lev, lcs);
  // 片方がもう片方を含む(OCRで前後にゴミが付いた)場合は底上げ
  if (x.includes(y) || y.includes(x)) {
    sim = Math.max(sim, Math.min(x.length, y.length) / maxLen * 0.5 + 0.5);
  }
  return sim;
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

/** 戦力を "38,870,574" 形式に */
export function formatPowerFull(p) {
  if (p == null || Number.isNaN(p)) return '-';
  return Math.round(p).toLocaleString('en-US');
}

/**
 * スクショ由来の概算戦力(例 38.8M)とマスターの正確な戦力がどの程度整合するか(0〜1)。
 * 表示は小数1桁に丸められるので ±0.05M 以内なら完全一致、そこから離れるほど下がる。
 */
export function powerAgreement(approx, exact) {
  if (approx == null || exact == null) return 0;
  const a = approx / 1e6, e = exact / 1e6;
  const diff = Math.abs(a - e);
  if (diff <= 0.051) return 1;
  const rel = diff / Math.max(e, 0.1);
  return Math.max(0, 1 - rel / 0.25); // 25%ずれで0
}

/**
 * 投票メンバー(OCR結果)をマスターと照合する。
 * @param {{name:string, power:number|null}} voter
 * @param {Array<{id:string,name:string,power:number}>} master
 * @returns {{entry:object|null, score:number, nameSim:number, powerSim:number, candidates:Array}}
 */
export function matchVoterToMaster(voter, master) {
  const candidates = master.map((entry) => {
    const nameSim = nameSimilarity(voter.name, entry.name);
    const powerSim = powerAgreement(voter.power, entry.power);
    // 名前重視。戦力は補助。ただし戦力一致かつ名前がそれなりなら強く支持
    let score = nameSim * 0.7 + powerSim * 0.3;
    if (powerSim === 1 && nameSim >= 0.35) score = Math.max(score, 0.75 + nameSim * 0.25);
    return { entry, nameSim, powerSim, score };
  }).sort((a, b) => b.score - a.score);

  const best = candidates[0];
  if (!best) return { entry: null, score: 0, nameSim: 0, powerSim: 0, weak: false, candidates: [] };
  const second = candidates[1];
  let accept =
    best.nameSim >= 0.85 ||
    (best.nameSim >= 0.5 && best.powerSim >= 0.6) ||
    (best.powerSim === 1 && best.nameSim >= 0.35 && (!second || second.score < best.score - 0.1));
  let weak = false;
  if (!accept && voter.power != null) {
    // 名前が読めていなくても、表示上の戦力(0.1M単位)と一致する人がマスターに1人だけならその人とみなす(要確認扱い)
    const exact = candidates.filter((c) => c.powerSim === 1);
    if (exact.length === 1) { accept = true; weak = true; }
  }
  const chosen = accept ? (weak ? candidates.find((c) => c.powerSim === 1) : best) : null;
  return {
    entry: chosen ? chosen.entry : null,
    score: chosen ? chosen.score : best.score,
    nameSim: chosen ? chosen.nameSim : best.nameSim,
    powerSim: chosen ? chosen.powerSim : best.powerSim,
    weak,
    candidates: candidates.slice(0, 5),
  };
}

/**
 * ランキングOCR結果をマスターの既存エントリに突き合わせる(マスター更新用)。
 * 名前が十分似ていれば同一人物。戦力が完全一致なら名前が化けていても同一人物とみなす。
 */
export function matchRankRowToMaster(row, master) {
  let best = null;
  for (const entry of master) {
    const nameSim = nameSimilarity(row.name, entry.name);
    const samePower = row.power != null && entry.power != null && row.power === entry.power;
    const score = samePower ? Math.max(0.95, nameSim) : nameSim;
    if (!best || score > best.score) best = { entry, score, nameSim, samePower };
  }
  if (best && (best.nameSim >= 0.8 || best.samePower)) return best;
  return { entry: null, score: best ? best.score : 0, nameSim: best ? best.nameSim : 0, samePower: false, candidate: best?.entry ?? null };
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
  let g = remainder === 'short' ? Math.ceil(n / size) : Math.max(1, Math.floor(n / size));
  const teams = Array.from({ length: g }, () => []);
  // スネーク配布
  let idx = 0, dir = 1, t = 0;
  while (idx < n) {
    teams[t].push(sorted[idx++]);
    if (dir === 1) {
      if (t === g - 1) dir = -1; else t++;
    } else {
      if (t === 0) dir = 1; else t--;
    }
  }
  if (balance && g > 1) balanceTeams(teams);
  return teams.map((members, i) => ({
    no: i + 1,
    members,
    total: members.reduce((s, m) => s + m.power, 0),
  }));
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

/** 編成結果をチャット貼り付け用テキストにする */
export function teamsToText(teams) {
  return teams
    .map((t) => `【${t.no}組】` + t.members.map((m) => `${m.name}(${formatPowerM(m.power)})`).join(' / ') + ` 合計 ${formatPowerM(t.total)}`)
    .join('\n');
}
