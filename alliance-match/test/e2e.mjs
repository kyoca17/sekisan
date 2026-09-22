// ブラウザ実機テスト(Playwright + Chromium)。
// 事前準備: npm run vendor で ./vendor を用意し、別ターミナルで npm run serve を起動しておく。
// 実行: FIXTURES=/path/to/screenshots node test/e2e.mjs
//   FIXTURES には vote*.png(投票メンバー画面)と poll.png(同盟投票画面)を置く。
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const FIX = process.env.FIXTURES;
if (!FIX) { console.error('FIXTURES=<スクショのディレクトリ> を指定してください'); process.exit(1); }
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8765';
const voteFiles = fs.readdirSync(FIX).filter((f) => /^vote.*\.png$/i.test(f)).sort().map((f) => path.join(FIX, f));
const pollFile = fs.existsSync(path.join(FIX, 'poll.png')) ? path.join(FIX, 'poll.png') : null;

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
// CDN を使わずローカルの vendor を使う
await page.route('https://cdn.jsdelivr.net/npm/tesseract.js@7/dist/tesseract.min.js', (r) => r.fulfill({ path: 'vendor/tesseract.min.js', contentType: 'application/javascript' }));
await page.goto(`${BASE}/index.html?ocr=local`);

await page.setInputFiles('#file-vote', voteFiles);
await page.waitForFunction(() => /人を読み取りました|失敗/.test(document.querySelector('#status-vote').textContent), null, { timeout: 600000 });
console.log('投票:', await page.textContent('#status-vote'));
console.table(await page.$$eval('#voters-table tbody tr', (trs) => trs.map((tr) => ({
  name: tr.querySelector('[data-field=name]').value, power: tr.querySelector('[data-field=power]').value, warn: tr.classList.contains('warn'),
}))));
if (pollFile) {
  await page.setInputFiles('#file-poll', pollFile);
  await page.waitForFunction(() => /と読み取りました|見つかりませんでした|失敗/.test(document.querySelector('#status-vote').textContent), null, { timeout: 600000 });
  console.log('同盟投票:', await page.textContent('#status-vote'));
}
await page.click('#btn-form');
if (!(await page.inputValue('#ann-datetime'))) await page.fill('#ann-datetime', '9/24(木)22:30');
console.log(await page.inputValue('#ann-text'));
await page.check('#ann-power');
console.log('--- 戦力あり ---\n' + await page.inputValue('#ann-text'));
await page.uncheck('#ann-power');
await page.click('#btn-copy');
console.log(await page.textContent('#status-ann'));
await page.screenshot({ path: 'e2e-result.png', fullPage: true });
await browser.close();
