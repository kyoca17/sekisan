// スクリーンショットの行(カード)検出・前処理・Tesseract.js による文字認識(ブラウザ専用)
import { parsePower, findDateTime } from './matching.js?v=12';

/* ---------- 画像ユーティリティ ---------- */

export async function loadImage(file) {
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(file); } catch (_) { /* fall through */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function drawToCanvas(img, w = img.width, h = img.height) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  return c;
}

export function toImageData(img) {
  const c = drawToCanvas(img);
  return c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);
}

const lum = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

/**
 * 縦方向の明度プロファイル(x0〜x1 の q 分位)。
 * 明るい背景に暗い文字なら q を高め、暗い背景に白い文字なら q を低めにすると文字の影響を受けにくい。
 */
function profileV(im, x0, x1, q = 0.5) {
  const { data, width: W, height: H } = im;
  const out = new Float32Array(H);
  const step = Math.max(1, Math.floor((x1 - x0) / 60));
  const buf = [];
  for (let y = 0; y < H; y++) {
    buf.length = 0;
    for (let x = x0; x < x1; x += step) buf.push(lum(data, (y * W + x) * 4));
    buf.sort((a, b) => a - b);
    out[y] = buf[Math.min(buf.length - 1, Math.floor(buf.length * q))];
  }
  return out;
}

/** mask の短い途切れ(文字の行などで一瞬背景に見える部分)を埋める */
function closeGaps(mask, maxGap) {
  const out = mask.slice();
  let lastTrue = -1;
  for (let i = 0; i < out.length; i++) {
    if (out[i]) {
      if (lastTrue >= 0 && i - lastTrue - 1 <= maxGap) for (let j = lastTrue + 1; j < i; j++) out[j] = true;
      lastTrue = i;
    }
  }
  return out;
}

/** 横方向の明度プロファイル(y0〜y1 の平均) */
function profileH(im, y0, y1) {
  const { data, width: W } = im;
  const out = new Float32Array(W);
  const step = Math.max(1, Math.floor((y1 - y0) / 40));
  for (let x = 0; x < W; x++) {
    let s = 0, n = 0;
    for (let y = y0; y < y1; y += step) { s += lum(data, (y * W + x) * 4); n++; }
    out[x] = s / n;
  }
  return out;
}

function percentile(arr, p) {
  const a = Array.from(arr).sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.max(0, Math.floor((a.length - 1) * p)))];
}

function runsOf(mask) {
  const r = [];
  let s = -1;
  for (let i = 0; i <= mask.length; i++) {
    const v = i < mask.length && mask[i];
    if (v && s < 0) s = i;
    if (!v && s >= 0) { r.push([s, i]); s = -1; }
  }
  return r;
}

/**
 * 高さが中央値に近い run だけ残す(タブ・見出しを除外)。
 * 画面下で切れたカードは、名前と戦力が見える程度(中央値の cutLo 以上)なら残し、fullHeight に完全な高さを入れて返す。
 * @returns {Array<[top, bottom, fullHeight, cut]>}
 */
function keepCardLikeRuns(rs, total, { minFrac = 0.03, lo = 0.8, hi = 1.5, cutLo = 0.5 } = {}) {
  const hs = rs.map(([a, b]) => b - a).filter((h) => h > minFrac * total).sort((a, b) => a - b);
  if (!hs.length) return [];
  // 完全なカードの高さ = 上位側の中央値(切れたカードに引きずられないよう、大きい方の半分で取る)
  const med = hs[Math.floor(hs.length / 2)];
  const full = hs.filter((h) => h >= lo * med);
  const fullMed = full.length ? full[Math.floor(full.length / 2)] : med;
  const out = [];
  const fullRuns = rs.filter(([a, b]) => { const h = b - a; return h >= lo * fullMed && h <= hi * fullMed; });
  const lastFullTop = fullRuns.length ? fullRuns[fullRuns.length - 1][0] : -1;
  for (const [a, b] of rs) {
    const h = b - a;
    if (h >= lo * fullMed && h <= hi * fullMed) out.push([a, b, h, false]);
    // 完全なカードより下にある短い run = 画面下で切れたカード(1つだけ)
    else if (a > lastFullTop && h >= cutLo * fullMed && h < lo * fullMed && !out.some((o) => o[3])) out.push([a, b, fullMed, true]);
  }
  return out;
}

/* ---------- レイアウト検出 ---------- */

/**
 * 投票メンバー画面: 明るいダイアログ上に中間色のカードが2列に並ぶ。
 * 返り値: [{left,top,width,height}]
 */
export function detectVoteCards(im) {
  const { width: W, height: H } = im;
  const cards = [];
  for (const [cx0, cx1] of [[0.05, 0.49], [0.51, 0.95]]) {
    // 列中央付近(アバターを避けた名前エリア)の縦プロファイル
    const prof = profileV(im, Math.floor(W * (cx0 + 0.16)), Math.floor(W * (cx1 - 0.03)), 0.25);
    const hi = percentile(prof, 0.95), lo = percentile(prof, 0.05);
    const mask = closeGaps(Array.from(prof, (v) => v < hi - 30 && v > lo + 40), Math.round(H * 0.004));
    const rows = keepCardLikeRuns(runsOf(mask), H);
    for (const [top, bottom, fullHeight, cut] of rows) {
      // 行の中で横方向にカードの範囲を求める
      const ph = profileH(im, top + Math.floor((bottom - top) * 0.05), bottom - Math.floor((bottom - top) * 0.05));
      const x0 = Math.floor(W * cx0), x1 = Math.floor(W * cx1);
      // 列の範囲内で「背景より暗い」最初と最後の x をカードの左右端とする
      // (アバター枠の白などでカード内が分断されても、端は正しく取れる)
      let left = -1, right = -1;
      for (let x = x0; x < x1; x++) if (ph[x] < hi - 25) { if (left < 0) left = x; right = x + 1; }
      if (left < 0 || right - left < W * 0.25) continue;
      // 切れたカードは完全な高さで扱う(名前・戦力の位置はカード上部にあるので読める)
      cards.push({ left, top, width: right - left, height: fullHeight, visibleHeight: bottom - top, cut, column: cx0 < 0.5 ? 0 : 1 });
    }
  }
  // 上から、同じ行なら左→右
  cards.sort((a, b) => (Math.abs(a.top - b.top) < 20 ? a.left - b.left : a.top - b.top));
  return cards;
}

/* ---------- 前処理 ---------- */

/**
 * 画像の一部を切り出し、拡大・グレースケール化・(任意で)二値化・反転・余白付与した canvas を返す。
 * @param {object} opt {scale, threshold, invert, pad, trimLeadingBlob}
 */
export function preprocess(img, box, opt = {}) {
  // 画像の範囲内にクリップ(画面下で切れたカードなど)
  box = {
    left: Math.max(0, box.left), top: Math.max(0, box.top),
    width: Math.min(box.width, img.width - Math.max(0, box.left)),
    height: Math.min(box.height, img.height - Math.max(0, box.top)),
  };
  const scale = opt.scale ?? 3;
  const pad = opt.pad ?? 16;
  const w = Math.max(1, Math.round(box.width * scale));
  const h = Math.max(1, Math.round(box.height * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, box.left, box.top, box.width, box.height, 0, 0, w, h);
  const id = ctx.getImageData(0, 0, w, h);
  const d = id.data;
  const gray = new Uint8ClampedArray(w * h);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) gray[p] = lum(d, i);

  let out = gray;
  if (opt.threshold == null) {
    // コントラストを引き伸ばす(メダル行など背景が濃い場合に文字が薄くなるのを防ぐ)
    const sorted = Array.from(gray).sort((a, b) => a - b);
    const lo = sorted[Math.floor(sorted.length * 0.02)], hi = sorted[Math.floor(sorted.length * 0.98)];
    if (hi - lo > 10) {
      out = new Uint8ClampedArray(w * h);
      for (let p = 0; p < gray.length; p++) out[p] = Math.max(0, Math.min(255, ((gray[p] - lo) * 255) / (hi - lo)));
    }
  }
  if (opt.threshold != null) {
    out = new Uint8ClampedArray(w * h);
    // 白文字(明るい)を残す場合は invert=true: 文字=白→黒, 背景=黒→白 に反転して黒文字/白背景にする
    for (let p = 0; p < gray.length; p++) {
      const on = gray[p] >= opt.threshold;
      out[p] = opt.invert ? (on ? 0 : 255) : (on ? 255 : 0);
    }
  } else if (opt.invert) {
    const src = out;
    out = new Uint8ClampedArray(w * h);
    for (let p = 0; p < src.length; p++) out[p] = 255 - src[p];
  }

  let cropLeft = 0;
  if (opt.trimLeadingBlob) {
    // 左端に写り込んだアイコンなどの塊を、最初の大きな空白まで読み飛ばす(二値画像前提: 文字=黒)
    const ink = new Int32Array(w);
    for (let x = 0; x < w; x++) { let s = 0; for (let y = 0; y < h; y++) if (out[y * w + x] < 128) s++; ink[x] = s; }
    const gapMin = Math.max(6, Math.round(h * 0.15));
    let x = 0;
    while (x < w && ink[x] === 0) x++;        // 先頭の空白
    const blobStart = x;
    if (blobStart < w * 0.35) {
      while (x < w && ink[x] > 0) x++;        // 最初の塊
      let gap = 0, gx = x;
      while (gx < w && ink[gx] === 0) { gap++; gx++; }
      if (gap >= gapMin && gx < w * 0.6) cropLeft = gx - Math.floor(gapMin / 2);
    }
  }

  const ow = w - cropLeft;
  const oc = document.createElement('canvas');
  oc.width = ow + pad * 2; oc.height = h + pad * 2;
  const octx = oc.getContext('2d');
  octx.fillStyle = '#fff';
  octx.fillRect(0, 0, oc.width, oc.height);
  const oid = octx.createImageData(ow, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < ow; x++) {
      const v = out[y * w + x + cropLeft];
      const o = (y * ow + x) * 4;
      oid.data[o] = oid.data[o + 1] = oid.data[o + 2] = v; oid.data[o + 3] = 255;
    }
  }
  octx.putImageData(oid, pad, pad);
  return oc;
}

/* ---------- Tesseract ラッパー ---------- */

export class OcrEngine {
  constructor(paths = {}) {
    // {workerPath, corePath, langPath} 省略時は jsDelivr CDN。
    // langUrls: {jpn: url, eng: url} を渡すと言語データをページ側で取得してワーカーに直接渡す
    // (CDN も langPath も使えない配信環境向け)
    this.paths = paths;
    this.langData = null;
    this.text = null;     // jpn+eng 1行
    this.digits = null;   // eng 数字のみ 1行
    this.sparse = null;   // jpn 散在テキスト(日時検出用、必要時に生成)
    this.ready = null;
  }

  init(onStatus = () => {}) {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      if (typeof Tesseract === 'undefined') throw new Error('Tesseract.js が読み込まれていません(ネットワークを確認してください)');
      const { langUrls, ...paths } = this.paths;
      const common = { ...paths, logger: (m) => { if (m.status && m.progress != null) onStatus(`${m.status} ${Math.round(m.progress * 100)}%`); } };
      onStatus('OCRエンジンを準備中(初回は数MBの言語データを取得します)…');
      if (langUrls) await this.fetchLangData(langUrls, onStatus);
      this.text = await Tesseract.createWorker(this.langs(['jpn', 'eng']), 1, common);
      await this.text.setParameters({ tessedit_pageseg_mode: '7', preserve_interword_spaces: '1' });
      this.digits = await Tesseract.createWorker(this.langs(['eng']), 1, common);
      await this.digits.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: '0123456789.,KMB' });
      onStatus('OCRエンジン準備完了');
    })();
    return this.ready;
  }

  /** 言語データを自前で取得している場合は {code, data} 形式で渡す */
  langs(codes) {
    if (!this.langData) return codes;
    return codes.map((code) => ({ code, data: this.langData[code] }));
  }

  async fetchLangData(langUrls, onStatus) {
    this.langData = {};
    for (const [code, url] of Object.entries(langUrls)) {
      onStatus(`言語データ(${code})を取得中…`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`言語データ ${code} を取得できません (${res.status})`);
      this.langData[code] = new Uint8Array(await res.arrayBuffer());
    }
  }

  async recognize(canvas, { digits = false } = {}) {
    await this.init();
    const w = digits ? this.digits : this.text;
    const { data } = await w.recognize(canvas);
    return { text: (data.text || '').replace(/\s+$/g, '').trim(), confidence: data.confidence ?? 0 };
  }

  /**
   * 画面全体から散在する文字を拾う(日時の検出用)。
   * jpn+eng だと「日」「木」がラテン文字に化けやすいので、日本語のみ・散在テキストモードの専用ワーカーを使う。
   */
  async recognizeSparse(canvas) {
    await this.init();
    if (!this.sparse) {
      const { langUrls, ...paths } = this.paths;
      this.sparse = await Tesseract.createWorker(this.langs(['jpn']), 1, paths);
      await this.sparse.setParameters({ tessedit_pageseg_mode: '11' });
    }
    const { data } = await this.sparse.recognize(canvas);
    return (data.text || '').trim();
  }

  async terminate() {
    for (const w of [this.text, this.digits, this.sparse]) if (w) await w.terminate();
    this.text = this.digits = this.sparse = this.ready = null;
  }
}

/* ---------- 画面種別ごとの抽出 ---------- */

function cleanName(s) {
  return (s || '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s|｜\[\]「」『』(（]+/, '')
    .replace(/[\s|｜\[\]「」『』)）]+$/, '')
    // 名前の末尾に紛れ込んだ戦力の数値(カンマ区切り)を除去
    .replace(/[\s,.]*(\d{1,3}(,\d{3})+|\d+[.,]\d+)$/, '')
    .trim();
}

/** 名前の認識: 通常版で信頼度が低ければ二値化版も試して良い方を採用 */
async function recognizeName(engine, img, box, { invert = false } = {}) {
  const variants = invert
    ? [{ threshold: 200, invert: true }]
    : [{}, { threshold: 150 }];
  let best = null;
  for (const v of variants) {
    const canvas = preprocess(img, box, { scale: 3, ...v });
    const r = await engine.recognize(canvas);
    r.text = cleanName(r.text);
    if (!best || (r.text && r.confidence > best.confidence) || (!best.text && r.text)) best = r;
    if (best.confidence >= 75 && best.text) break;
  }
  return best || { text: '', confidence: 0 };
}

/**
 * 投票メンバー画面から {name, power(概算)} の配列を抽出
 */
export async function extractVoteCards(engine, file, onStatus = () => {}) {
  const img = await loadImage(file);
  const im = toImageData(img);
  const cards = detectVoteCards(im);
  onStatus(`${cards.length} 人分のカードを検出。文字認識中…`);
  const results = [];
  for (const [i, c] of cards.entries()) {
    const nameBox = { left: c.left + Math.floor(c.width * 0.38), top: c.top + Math.floor(c.height * 0.07), width: Math.floor(c.width * 0.60), height: Math.floor(c.height * 0.30) };
    const powBox = { left: c.left + Math.floor(c.width * 0.40), top: c.top + Math.floor(c.height * 0.36), width: Math.floor(c.width * 0.52), height: Math.floor(c.height * 0.27) };
    if (c.cut) {
      // 下で切れたカード: 見えている範囲までに戦力の切り出しを縮める。ほとんど見えなければ諦める
      const visibleBottom = c.top + c.visibleHeight;
      powBox.height = Math.min(powBox.height, visibleBottom - powBox.top);
      if (powBox.height < c.height * 0.12) { onStatus(`文字認識中… ${i + 1}/${cards.length}`); continue; }
    }
    const name = await recognizeName(engine, img, nameBox, { invert: true });
    const pow = await engine.recognize(preprocess(img, powBox, { scale: 3, threshold: 200, invert: true, trimLeadingBlob: true }), { digits: true });
    let power = parsePower(pow.text);
    if (power != null && (power < 1000 || power > 9.99e9)) power = null;
    // 下で切れたカードで戦力まで読めなかった場合は捨てる(次のスクショに写っているはず)
    if (c.cut && (power == null || !name.text)) { onStatus(`文字認識中… ${i + 1}/${cards.length}`); continue; }
    results.push({
      name: name.text, nameConf: Math.round(name.confidence),
      power, rawPower: pow.text, powerConf: Math.round(pow.confidence),
      box: c, cut: !!c.cut,
    });
    onStatus(`文字認識中… ${i + 1}/${cards.length}`);
  }
  return { rows: results, image: img, width: im.width, height: im.height };
}

/**
 * スクリーンショットの中から開催日時("9/24(木) 22:30" など)を探す。見つからなければ null
 * 画面全体を対象にするので、投票メンバーのカード検出とは独立して動く。
 */
export async function extractDateTime(engine, img) {
  const W = img.width, H = img.height;
  // 解像度が高すぎると遅いので幅 1000px 程度に縮小
  const scale = Math.min(1, 1000 / W);
  const canvas = preprocess(img, { left: 0, top: 0, width: W, height: H }, { scale, pad: 8 });
  const text = await engine.recognizeSparse(canvas);
  return { found: findDateTime(text), rawText: text };
}
