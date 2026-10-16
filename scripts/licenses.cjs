// Collects the licenses of every package shipped with Kea into public/licenses/third-party.txt.
// Run automatically before each build.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkgJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
// Shipped code = runtime dependencies + the libraries Vite bundles into the app (rendererDependencies).
const shipped = new Set([...Object.keys(pkgJson.dependencies || {}), ...(pkgJson.rendererDependencies || [])]);
let raw;
try {
  raw = execSync('npm ls --all --json', { cwd: root, maxBuffer: 64 << 20 }).toString();
} catch (err) {
  // npm ls exits non-zero for harmless peer-dependency warnings; its output is still usable.
  raw = err.stdout.toString();
}
const tree = JSON.parse(raw);
const seen = new Map();
(function walk(deps, top) {
  for (const [name, info] of Object.entries(deps || {})) {
    if (top && !shipped.has(name)) continue;
    if (!info || !info.version || seen.has(name + '@' + info.version)) continue;
    seen.set(name + '@' + info.version, name);
    walk(info.dependencies, false);
  }
})(tree.dependencies, true);

const out = [
  'Kea includes the following open-source software. Thank you to everyone who made it.',
  '',
  'AI MODELS (downloaded only if you choose them in Settings → AI)',
  '  • Llama 3.2 3B Instruct: Llama 3.2 is licensed under the Llama 3.2 Community License, Copyright © Meta Platforms, Inc. All Rights Reserved. Built with Llama. See LLAMA-3.2-LICENSE.txt and LLAMA-3.2-USE-POLICY.md.',
  '  • Qwen2.5 1.5B Instruct and Qwen2.5 7B Instruct: Copyright Alibaba Cloud, Apache License 2.0.',
  '  • Model files are the GGUF conversions published by bartowski on Hugging Face.',
  '',
  'SOFTWARE PACKAGES',
  ''
];
const entries = [...seen.keys()].sort((a, b) => a.localeCompare(b));
for (const id of entries) {
  const name = seen.get(id);
  const dir = path.join(root, 'node_modules', name);
  let pkg = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    continue;
  }
  const license = pkg.license || (pkg.licenses && pkg.licenses.map((l) => l.type || l).join(' OR ')) || 'see package';
  out.push('='.repeat(78), `${id}  (${license})`, pkg.homepage || (pkg.repository && (pkg.repository.url || pkg.repository)) || '', '');
  const file = fs.existsSync(dir) && fs.readdirSync(dir).find((f) => /^(licen[sc]e|copying|notice)(\.|$)/i.test(f));
  if (file) out.push(fs.readFileSync(path.join(dir, file), 'utf8').trim(), '');
}
out.push('='.repeat(78), 'Electron and Chromium: MIT and BSD-style licenses, see LICENSES.chromium.html in the install folder.');
fs.mkdirSync(path.join(root, 'public', 'licenses'), { recursive: true });
fs.writeFileSync(path.join(root, 'public', 'licenses', 'third-party.txt'), out.join('\n'));
console.log(`licenses: ${entries.length} packages`);
