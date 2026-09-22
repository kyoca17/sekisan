// claude.ai の Artifact として公開するためのページを dist-artifact/ に組み立てる。
// - Artifact 側が <html>/<head>/<body> を付けるので、本体だけのHTMLにする
// - 外部CDNへの実行時取得が制限されるため、Tesseract 本体・ワーカー・言語データを同梱(vendor/ が必要: npm run vendor)
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(new URL('..', import.meta.url).pathname);
const out = path.join(root, 'dist-artifact');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'vendor/lang'), { recursive: true });
fs.mkdirSync(path.join(out, 'js'), { recursive: true });

let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css/style.css'), 'utf8');
const body = html.slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('</body>'));
const page = `<title>同盟 3人組マッチング</title>
<style>
${css}
</style>
<script>window.OCR_LOCAL = true; window.OCR_LANG_URLS = { jpn: './vendor/lang/jpn.traineddata.wasm', eng: './vendor/lang/eng.traineddata.wasm' };</script>
<script src="./vendor/tesseract.min.js"></script>
${body.trim()}
`;
fs.writeFileSync(path.join(out, 'index.html'), page);
for (const f of ['app.js', 'ocr.js', 'matching.js']) fs.copyFileSync(path.join(root, 'js', f), path.join(out, 'js', f));
fs.mkdirSync(path.join(out, 'img'), { recursive: true });
for (const f of ['sample-vote.svg', 'sample-poll.svg']) fs.copyFileSync(path.join(root, 'img', f), path.join(out, 'img', f));
const vendor = ['tesseract.min.js', 'worker.min.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js', 'tesseract-core-lstm.wasm.js'];
for (const f of vendor) fs.copyFileSync(path.join(root, 'vendor', f), path.join(out, 'vendor', f));
// tesseract.js v7 のワーカーは {code,data} 形式の言語指定で code ではなく data を連結してしまうバグがあるので修正する
const wp = path.join(out, 'vendor/worker.min.js');
const before = 'return"string"==typeof t?t:t.data})).join("+")';
let worker = fs.readFileSync(wp, 'utf8');
if (!worker.includes(before)) throw new Error('worker.min.js のパッチ対象が見つかりません(tesseract.js のバージョンを確認)');
worker = worker.replace(before, 'return"string"==typeof t?t:t.code})).join("+")');
fs.writeFileSync(wp, worker);
// 言語データ(.traineddata.gz)は配信できる拡張子が限られるため .wasm 名で置く(中身は gzip のまま。ページ側で取得してワーカーに渡す)
for (const lang of ['jpn', 'eng']) fs.copyFileSync(path.join(root, 'vendor/lang', `${lang}.traineddata.gz`), path.join(out, 'vendor/lang', `${lang}.traineddata.wasm`));
console.log('dist-artifact/ を作成しました');
