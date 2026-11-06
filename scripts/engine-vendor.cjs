// Bundles the parts of transformers.js the Kea engine needs (speech recognition in Node) into one file,
// electron/vendor/transformers.cjs, so the installed app doesn't ship transformers' browser runtime (onnxruntime-web,
// ~130 MB) or the sharp image library. onnxruntime-node stays external (it's a real dependency, unpacked from asar).
// Runs before every build; the output is gitignored.
const path = require('path');
const fs = require('fs');
const out = path.join(__dirname, '..', 'electron', 'vendor', 'transformers.cjs');
const stub = path.join(__dirname, 'vendor-stub.cjs');
fs.mkdirSync(path.dirname(out), { recursive: true });
require('esbuild').buildSync({
  entryPoints: [path.join(__dirname, '..', 'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.node.cjs')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: out,
  external: ['onnxruntime-node'],
  alias: { sharp: stub, 'onnxruntime-web': stub },
  minify: true,
  legalComments: 'external',
  logLevel: 'warning'
});
console.log('engine vendor bundle:', path.relative(process.cwd(), out), Math.round(fs.statSync(out).size / 1024) + ' KB');
