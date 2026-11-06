// Ending a program together with everything it started. Claude Code runs Bash, uv and Python under it; killing only
// claude.exe would leave those running (Windows doesn't end a process's children with it).
const { execFile } = require('child_process');

/** End process `pid` and its whole tree. Resolves true when it was ended (or was already gone). */
function killTree(pid) {
  return new Promise((resolve) => {
    if (!Number.isInteger(pid) || pid <= 0) return resolve(false);
    if (process.platform === 'win32') {
      execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (err, _out, errText) => {
        // 128: no such process (it had already ended).
        resolve(!err || err.code === 128 || /not found|no running instance/i.test(String(errText || '')));
      });
      return;
    }
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    resolve(true);
  });
}

module.exports = { killTree };
