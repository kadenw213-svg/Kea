// A profile's scan workspace and the programs class scans need: uv (Python and the engine's packages) and Claude Code
// (the user's own Claude account). Kea installs them for the user, explaining each, and keeps the engine up to date.
const { app } = require('electron');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const profiles = require('./profiles.cjs');

/** Kea's bundled Scholar files: the engine, its guidelines (CLAUDE.md) and skills. */
const bundled = () => (app.isPackaged ? path.join(process.resourcesPath, 'scholar') : path.join(__dirname, '..', '..', 'scholar'));

const ENGINE_FILES = ['src', 'docs', 'config', 'pyproject.toml', 'uv.lock', '.python-version', 'README.md'];

/**
 * Copy the engine, Kea's guidelines and the skills into the profile's workspace (code only: its data folder, with the
 * database and downloads, is never touched). Done on setup and whenever Kea's version changes.
 */
function prepare(force = false) {
  const p = profiles.paths();
  const stamp = path.join(p.workspace, '.kea-version');
  const version = app.getVersion();
  if (!force && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === version) return p.workspace;
  const src = bundled();
  fs.mkdirSync(p.workspace, { recursive: true });
  for (const f of ENGINE_FILES) {
    const from = path.join(src, 'engine', f);
    if (!fs.existsSync(from)) continue;
    fs.rmSync(path.join(p.workspace, f), { recursive: true, force: true });
    fs.cpSync(from, path.join(p.workspace, f), { recursive: true, filter: (x) => !/__pycache__|\.pyc$/.test(x) });
  }
  fs.copyFileSync(path.join(src, 'kea', 'CLAUDE.md'), path.join(p.workspace, 'CLAUDE.md'));
  const skills = path.join(p.workspace, '.claude', 'skills');
  fs.rmSync(skills, { recursive: true, force: true });
  fs.cpSync(path.join(src, 'skills'), skills, { recursive: true });
  fs.mkdirSync(path.join(p.workspace, 'data'), { recursive: true });
  fs.writeFileSync(stamp, version);
  return p.workspace;
}

// ---------- Finding the programs ----------
const exists = (f) => {
  try {
    return fs.statSync(f).isFile();
  } catch {
    return false;
  }
};
function where(name) {
  return new Promise((resolve) => execFile('where.exe', [name], { windowsHide: true }, (err, out) => resolve(err ? [] : String(out).split(/\r?\n/).filter(Boolean))));
}
async function findUv() {
  const home = os.homedir();
  for (const f of [path.join(home, '.local', 'bin', 'uv.exe'), path.join(home, '.cargo', 'bin', 'uv.exe')]) if (exists(f)) return f;
  return (await where('uv.exe'))[0] || null;
}
/** Claude Code's real executable (not npm's .cmd wrapper, which can't be started hidden cleanly). */
async function findClaude() {
  const home = os.homedir();
  const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const candidates = [path.join(home, '.local', 'bin', 'claude.exe'), path.join(appdata, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'), path.join(home, '.claude', 'local', 'claude.exe')];
  for (const f of candidates) if (exists(f)) return f;
  for (const f of await where('claude.exe')) if (exists(f)) return f;
  return null;
}

/** Run a program hidden and collect its output. */
function runHidden(file, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { windowsHide: true, ...opts });
    let out = '';
    child.stdout?.on('data', (d) => ((out += d), opts.onLine?.(String(d))));
    child.stderr?.on('data', (d) => ((out += d), opts.onLine?.(String(d))));
    child.on('error', (err) => resolve({ code: -1, out: String(err.message) }));
    child.on('close', (code) => resolve({ code, out }));
  });
}

/** Whether Claude Code is signed in, and as whom (from `claude auth status`). */
async function claudeAccount(claude) {
  if (!claude) return { loggedIn: false };
  const r = await runHidden(claude, ['auth', 'status', '--json']);
  try {
    const j = JSON.parse(r.out.slice(r.out.indexOf('{')));
    return { loggedIn: !!j.loggedIn, email: j.email || '', method: j.authMethod || '', plan: j.subscriptionType || j.plan || '' };
  } catch {
    return { loggedIn: false };
  }
}

/** Everything the setup screen needs to know. */
async function check() {
  const [uv, claude] = await Promise.all([findUv(), findClaude()]);
  const p = profiles.paths();
  return {
    uv,
    claude,
    account: await claudeAccount(claude),
    engineReady: exists(path.join(p.workspace, '.venv', 'Scripts', 'python.exe')),
    hasData: exists(p.db)
  };
}

// ---------- Installing ----------
const powershell = (command, onLine) => runHidden('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { onLine });

/** uv, from its makers (Astral), into the user's own folder (no admin rights). */
const installUv = (onLine) => powershell('irm https://astral.sh/uv/install.ps1 | iex', onLine);

/** Claude Code, with Anthropic's official Windows installer (into the user's own folder). */
const installClaude = (onLine) => powershell('irm https://claude.ai/install.ps1 | iex', onLine);

/** Claude's sign-in needs the user: it opens in its own small window (and their browser), and Kea waits for it. */
async function signInClaude() {
  const claude = await findClaude();
  if (!claude) throw new Error('Claude Code isn’t installed yet.');
  spawn('cmd.exe', ['/c', 'start', '"Sign in to Claude for Kea"', claude, 'auth', 'login'], { windowsHide: true, detached: true }).unref();
  for (let i = 0; i < 300; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const a = await claudeAccount(claude);
    if (a.loggedIn) return a;
  }
  return { loggedIn: false };
}

/** Python and the engine's packages (uv downloads Python 3.12 itself), then the engine's database. */
async function setupEngine(home, onLine) {
  const uv = await findUv();
  if (!uv) throw new Error('uv isn’t installed yet.');
  const cwd = prepare();
  const env = engineEnv(uv);
  let r = await runHidden(uv, ['sync', '--frozen'], { cwd, env, onLine });
  if (r.code !== 0) r = await runHidden(uv, ['sync'], { cwd, env, onLine });
  if (r.code !== 0) throw new Error(`Installing the engine failed:\n${r.out.slice(-1500)}`);
  r = await runHidden(uv, ['run', 'academic-sync', 'db-init'], { cwd, env, onLine });
  if (r.code !== 0) throw new Error(`Creating the class database failed:\n${r.out.slice(-1500)}`);
  if (home) await runHidden(uv, ['run', 'academic-sync', 'prefs', 'set', 'd2l_base_url', home], { cwd, env, onLine });
  return true;
}

/** The environment class scans and the engine run with. */
function engineEnv(uv) {
  const p = profiles.paths();
  return {
    ...process.env,
    PATH: [uv ? path.dirname(uv) : '', process.env.PATH || ''].filter(Boolean).join(path.delimiter),
    KEA_TEXTBOOK_DIR: p.textbooks,
    // The class site's name in what the engine writes ("From Canvas (…)", the "Canvas" link label).
    KEA_SITE_NAME: require('./browser.cjs').platformOf() === 'canvas' ? 'Canvas' : 'D2L',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1'
  };
}

module.exports = { prepare, check, findUv, findClaude, installUv, installClaude, signInClaude, setupEngine, engineEnv, runHidden };
