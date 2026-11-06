// Runs after `npm install`. The project folder lives in OneDrive, and npm replaces the node_modules link with a real
// folder, which OneDrive then uploads (gigabytes) and turns into online-only files that builds can't read. This puts
// node_modules back in %LOCALAPPDATA%\KeaBuild and links it here again. Does nothing outside OneDrive or Windows.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const here = path.join(root, 'node_modules');
if (process.platform !== 'win32' || !/onedrive/i.test(root)) process.exit(0);
const st = fs.lstatSync(here, { throwIfNoEntry: false });
if (!st || st.isSymbolicLink()) process.exit(0);
const away = path.join(process.env.LOCALAPPDATA, 'KeaBuild', 'node_modules');
try {
  fs.rmSync(away, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(away), { recursive: true });
  // robocopy /MOVE also downloads any online-only file on the way out.
  execSync(`robocopy "${here}" "${away}" /E /MOVE /NFL /NDL /NJH /NJS /R:1 /W:1`, { stdio: 'ignore' });
} catch {
  // robocopy exits non-zero on success too.
}
fs.rmSync(here, { recursive: true, force: true });
fs.symlinkSync(away, here, 'junction');
console.log(`node_modules kept out of OneDrive (${away}).`);
