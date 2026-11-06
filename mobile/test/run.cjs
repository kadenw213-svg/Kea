// Bundles the phone's study code the way the app does (same stand-ins for Node's modules) and runs its test in Node.
// node mobile/test/run.cjs <kea-data.json> <study folder>
const path = require('path');
const esbuild = require('esbuild');

const src = path.join(__dirname, '..', 'src');
const stand = {
  fs: path.join(src, 'node', 'fs.ts'),
  path: path.join(src, 'node', 'path.ts'),
  crypto: path.join(src, 'node', 'crypto.ts'),
  './profiles.cjs': path.join(src, 'node', 'profiles.ts'),
  './db.cjs': path.join(src, 'node', 'db.ts')
};
const out = path.join(require('os').tmpdir(), 'kea-mobile-study-test.cjs');

esbuild
  .build({
    entryPoints: [path.join(__dirname, 'study.test.ts')],
    bundle: true,
    platform: 'neutral',
    format: 'cjs',
    outfile: out,
    mainFields: ['module', 'main'],
    plugins: [
      {
        name: 'stand-ins',
        setup(b) {
          b.onResolve({ filter: /^(fs|path|crypto|\.\/profiles\.cjs|\.\/db\.cjs|\.\/(browser|runner|precheck|workspace)\.cjs)$/ }, (a) => {
            // (The test itself reads the real files with require: only study.cjs and the phone's code get stand-ins.)
            if (a.importer.endsWith('study.test.ts')) return { path: a.path, external: true };
            return { path: stand[a.path] || path.join(src, 'node', 'stub.ts') };
          });
        }
      }
    ]
  })
  .then(() => {
    require(out);
  });
