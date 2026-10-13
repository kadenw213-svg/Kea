// Builds the Windows installer and publishes it as a GitHub release.
// Usage: bump "version" in package.json, then run `npm run release`.
// Installed copies of Slate Office pick the new version up from "Check for updates".
const { execSync } = require('child_process');
const pkg = require('../package.json');

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

console.log(`\nReleasing Slate Office v${pkg.version}\n`);
run('npx vite build');
run('npx electron-builder --win --x64 --publish always', { GH_TOKEN: token });
console.log(`\nPublished v${pkg.version}: https://github.com/kadenw213-svg/slate-office/releases/tag/v${pkg.version}\n`);
