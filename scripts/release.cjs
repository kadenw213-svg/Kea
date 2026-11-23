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
// The built-in sign-in clients (electron/buildConfig.json, from the owner's file outside the repo; a warning without it).
run('node scripts/oauth-clients.cjs');
// Without the built-in Google client, Kea gets it from the Kea account server instead (KeaC 0.14 /v1/sign-in-clients,
// electron/oauthClients.cjs ensure()), so a build without it still signs in. Say so, so it's never a surprise.
{
  const built = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'electron', 'buildConfig.json'), 'utf8') || '{}');
  if (!built.google?.desktopClientId) console.warn('\nNote: no Google client built in. Kea will get it from the Kea account server (KeaC 0.14 or newer).\n');
}
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
