// Runs a class scan: Claude Code, started hidden in the profile's workspace with Kea's guidelines and skills, the Kea
// Connector's tools, and nothing else allowed. One run at a time; progress and news go to Kea as they happen.
const { BrowserWindow, Notification } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const profiles = require('./profiles.cjs');
const workspace = require('./workspace.cjs');
const mcp = require('./mcp.cjs');

const KEA_TOOLS = ['d2l_open', 'd2l_fetch', 'd2l_download', 'd2l_status', 'kea_progress', 'kea_notify'].map((t) => `mcp__kea__${t}`);
const BASE = ['Bash(uv run academic-sync:*)', 'Read', 'Glob', 'Grep', 'Skill', 'ToolSearch', 'Edit(data/**)', 'Write(data/**)'];

/** What each kind of run does, and the only tools it may use. */
const TASKS = {
  // The daily check: news per class, new class shells (imported in full), small calendar upkeep.
  daily: { prompt: () => '/daily-overview', tools: [...BASE, ...KEA_TOOLS], label: 'Daily check' },
  // A class's first full scan (or every new class, with no argument).
  import: { prompt: (arg) => `/academic-import ${arg || ''}`.trim(), tools: [...BASE, ...KEA_TOOLS], label: 'Scanning a new class' },
  // The weekly re-scan: next weeks' readings, refreshed links.
  sync: { prompt: (arg) => `/academic-sync ${arg || ''}`.trim(), tools: [...BASE, ...KEA_TOOLS], label: 'Weekly class update' },
  // Setup's "Test connection": Claude Code reaches Kea's tools and says what it sees (a few seconds, tiny usage).
  probe: {
    prompt: () => 'This is a connection test from Kea. Call mcp__kea__kea_progress with the message "Connection test", then mcp__kea__d2l_status, then reply with one short sentence saying whether the class site is set up and signed in. Do nothing else.',
    tools: ['mcp__kea__kea_progress', 'mcp__kea__d2l_status'],
    label: 'Connection test'
  },
  // This week's textbook chapters (no class site needed; open educational sources for figures and checking facts).
  study: { prompt: (arg) => `/weekly-study-pdf ${arg || ''}`.trim(), tools: [...BASE, 'WebFetch', 'WebSearch', 'mcp__kea__kea_progress', 'mcp__kea__kea_notify'], label: 'Writing textbook chapters' }
};

let current = null;
const queue = [];

const send = (channel, payload) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send(channel, payload));

// ---------- What Kea keeps about runs and news (per profile) ----------
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
const activityFile = () => path.join(profiles.paths().dir, 'activity.json');
const newsFile = () => path.join(profiles.paths().dir, 'news.json');
function saveActivity(entry) {
  const list = readJson(activityFile(), []).filter((e) => e.id !== entry.id);
  list.unshift(entry);
  fs.mkdirSync(path.dirname(activityFile()), { recursive: true });
  fs.writeFileSync(activityFile(), JSON.stringify(list.slice(0, 60), null, 1));
}
function addNews(n) {
  const list = readJson(newsFile(), []);
  list.unshift({ id: `${Date.now()}`, at: new Date().toISOString(), read: false, ...n });
  fs.mkdirSync(path.dirname(newsFile()), { recursive: true });
  fs.writeFileSync(newsFile(), JSON.stringify(list.slice(0, 300), null, 1));
  send('scholar:news', n);
  if (Notification.isSupported()) new Notification({ title: n.course ? `${n.course}: ${n.title}` : n.title, body: n.body.slice(0, 220) }).show();
}

/** Queue a run. Resolves when it finishes, with its summary. */
function run(task, arg = '', why = 'manual') {
  if (!TASKS[task]) throw new Error(`Unknown run: ${task}`);
  return new Promise((resolve) => {
    queue.push({ task, arg, why, resolve, profile: profiles.active() });
    next();
  });
}

async function next() {
  if (current || !queue.length) return;
  const job = queue.shift();
  // A run belongs to the profile it was queued for (profiles can't be switched while one runs).
  if (job.profile !== profiles.active()) {
    job.resolve(null);
    return next();
  }
  const t = TASKS[job.task];
  const entry = { id: `${Date.now()}`, task: job.task, label: t.label, arg: job.arg, why: job.why, start: new Date().toISOString(), end: null, ok: null, summary: '', steps: [] };
  current = { entry, child: null, server: null };
  const step = (message) => {
    entry.steps.push({ at: new Date().toISOString(), message });
    if (entry.steps.length > 200) entry.steps.shift();
    send('scholar:run', { ...entry, running: true });
  };
  const finish = (ok, summary) => {
    entry.end = new Date().toISOString();
    entry.ok = ok;
    entry.summary = summary;
    saveActivity(entry);
    send('scholar:run', { ...entry, running: false });
    send('scholar:changed');
    current?.server?.close();
    current = null;
    job.resolve(entry);
    next();
  };
  try {
    const claude = await workspace.findClaude();
    const uv = await workspace.findUv();
    if (!claude || !uv) return finish(false, 'Class scans aren’t set up yet (Claude Code and uv are needed).');
    const cwd = workspace.prepare();
    const server = await mcp.start({ progress: step, notify: (n) => addNews(n) });
    current.server = server;
    const cfg = path.join(cwd, 'data', 'kea-mcp.json');
    fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { kea: { type: 'http', url: server.url, headers: { Authorization: `Bearer ${server.token}` } } } }));
    const log = path.join(cwd, 'data', 'logs', `kea-${job.task}-${entry.start.slice(0, 10)}.log`);
    fs.mkdirSync(path.dirname(log), { recursive: true });
    const out = fs.createWriteStream(log, { flags: 'a' });
    out.write(`\n=== ${entry.start} ${job.task} ${job.arg} (${job.why}) ===\n`);
    const args = ['-p', t.prompt(job.arg), '--output-format', 'stream-json', '--verbose', '--mcp-config', cfg, '--strict-mcp-config', '--permission-mode', 'dontAsk', '--allowedTools', ...t.tools];
    step(`${t.label}…`);
    const child = spawn(claude, args, { cwd, env: workspace.engineEnv(uv), windowsHide: true });
    current.child = child;
    let buf = '';
    let result = null;
    child.stdout.on('data', (d) => {
      out.write(d);
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'result') result = ev;
        } catch {}
      }
    });
    child.stderr.on('data', (d) => out.write(d));
    child.on('error', (err) => (out.end(), finish(false, `Couldn’t start Claude Code: ${err.message}`)));
    child.on('close', (code) => {
      out.write(`\n=== exit ${code} ===\n`);
      out.end();
      fs.rm(cfg, { force: true }, () => {});
      if (result && !result.is_error) finish(true, String(result.result || 'Done.').trim().slice(0, 4000));
      else finish(false, result?.result ? String(result.result).slice(0, 2000) : code === null ? 'Stopped.' : `The scan ended early (code ${code}). Details are in the scan log.`);
    });
  } catch (err) {
    finish(false, String(err?.message || err));
  }
}

function stop() {
  queue.length = 0;
  if (current?.child) current.child.kill();
}

const status = () => ({ running: current ? { ...current.entry, running: true } : null, queued: queue.map((j) => ({ task: j.task, arg: j.arg })) });
const activity = () => readJson(activityFile(), []);
const news = () => readJson(newsFile(), []);
function markNewsRead(ids) {
  const list = readJson(newsFile(), []);
  for (const n of list) if (!ids || ids.includes(n.id)) n.read = true;
  fs.writeFileSync(newsFile(), JSON.stringify(list, null, 1));
  return true;
}

module.exports = { run, stop, status, activity, news, markNewsRead, TASKS };
