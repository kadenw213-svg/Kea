// Builds the Windows installer and publishes it as a GitHub release.
// Usage: bump "version" in package.json, then run `npm run release`.
// Installed copies of Kea pick the new version up from "Check for updates".
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pkg = require('../package.json');

// Installers are built outside the project folder (which lives in OneDrive), so they never sync to the cloud, and
// only the newest is kept: every published version is on GitHub anyway.
const OUT = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'KeaBuild', 'release');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const run = (cmd, env) => execSync(cmd, { stdio: 'inherit', env: { ...process.env, ...env } });

let token = process.env.GH_TOKEN;
if (!token) {
  try {
    token = execSync('gh auth token', { encoding: 'utf8' }).trim();
  } catch {
    console.error('Sign in to GitHub first: gh auth login');
    process.exit(1);
  }
}

console.log(`\nReleasing Kea v${pkg.version}\n`);
run('node scripts/licenses.cjs');
run('node scripts/assets.cjs');
run('node scripts/engine-vendor.cjs');
run('npx vite build');
run(`npx electron-builder --win --x64 --publish always -c.directories.output="${OUT}"`, { GH_TOKEN: token });
// Kea for Android rides along on every release, so ".../releases/latest/download/Kea-Android.apk" always works.
try {
  run('node scripts/mobile-apk.cjs');
  const apk = path.join(path.dirname(OUT), 'Kea.apk');
  const named = path.join(path.dirname(OUT), 'Kea-Android.apk');
  fs.copyFileSync(apk, named);
  run(`gh release upload v${pkg.version} "${named}" --clobber -R kadenw213-svg/kea`, { GH_TOKEN: token });
} catch (err) {
  console.error('The Android app was not attached to this release:', err.message);
}
console.log(`\nPublished v${pkg.version}: https://github.com/kadenw213-svg/kea/releases/tag/v${pkg.version}\n`);
