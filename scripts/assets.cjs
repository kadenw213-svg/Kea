// Copies files that must be served as-is (not bundled) into public/ before each build:
// the OCR engine (Tesseract) and its English language data, so OCR works offline.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'public', 'tesseract');
fs.mkdirSync(path.join(out, 'lang'), { recursive: true });
const copy = (from, to) => fs.copyFileSync(path.join(root, 'node_modules', from), path.join(out, to));
copy('tesseract.js/dist/worker.min.js', 'worker.min.js');
for (const f of fs.readdirSync(path.join(root, 'node_modules', 'tesseract.js-core'))) {
  // Only the LSTM engine builds are used (Kea always runs the LSTM recogniser); each is self-contained.
  if (/^tesseract-core(-simd|-relaxedsimd)?-lstm\.wasm\.js$/.test(f)) copy(`tesseract.js-core/${f}`, f);
}
copy('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'lang/eng.traineddata.gz');
console.log('assets: OCR engine copied');
