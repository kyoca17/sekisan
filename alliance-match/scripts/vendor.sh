#!/usr/bin/env bash
# Tesseract.js の実行ファイルと言語データを ./vendor に配置する(オフライン利用・ローカルテスト用)。
# 通常の利用では CDN(jsDelivr)から自動取得されるので不要。使うときは URL に ?ocr=local を付ける。
set -euo pipefail
cd "$(dirname "$0")/.."
npm install --no-save tesseract.js@7 @tesseract.js-data/jpn @tesseract.js-data/eng >/dev/null
mkdir -p vendor/lang
cp node_modules/tesseract.js/dist/tesseract.min.js node_modules/tesseract.js/dist/worker.min.js vendor/
cp node_modules/tesseract.js-core/tesseract-core*.wasm.js node_modules/tesseract.js-core/tesseract-core*.wasm vendor/
cp node_modules/@tesseract.js-data/jpn/4.0.0_best_int/jpn.traineddata.gz node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz vendor/lang/
echo "vendor/ に配置しました: $(du -sh vendor | cut -f1)"
