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
  daily: { prompt: (arg) => `/daily-overview ${arg || ''}`.trim(), tools: [...BASE, ...KEA_TOOLS], label: 'Daily check' },
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

// ---------- Claude usage limits: pause, then continue where the run stopped ----------
const LIMIT = /hit your (?:session |usage |weekly |daily )?limit|usage limit reached|limit (?:will )?resets?/i;

/** When a "resets 8:10pm" message means the limit is over (local time), or in an hour when it can't be read. */
function resetTime(msg, now = new Date()) {
  const m = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(msg || '');
  if (!m) return new Date(now.getTime() + 60 * 60000);
  let h = Number(m[1]) % 12;
  if ((m[3] || '').toLowerCase() === 'pm') h += 12;
  if (!m[3] && Number(m[1]) === 12) h = 12;
  const at = new Date(now);
  at.setHours(h, Number(m[2] || 0), 0, 0);
  if (at <= now) at.setDate(at.getDate() + 1);
  // A couple of minutes' grace so the limit has really reset.
  return new Date(at.getTime() + 3 * 60000);
}

const resumeFile = () => path.join(profiles.paths().dir, 'resume.json');
/** The run waiting to continue after a usage limit, if any: { task, arg, until, label }. */
const pending = () => readJson(resumeFile(), null);
function setPending(p) {
  if (p) fs.writeFileSync(resumeFile(), JSON.stringify(p, null, 1));
  else fs.rmSync(resumeFile(), { force: true });
  send('scholar:resume', p);
}

/** The argument that makes a task continue instead of starting over (see "Continuing a run" in Kea's CLAUDE.md). */
const resumeArg = (arg) => (/\bresume\b/.test(arg || '') ? arg : `${arg || ''} resume`.trim());

/** Continue the waiting run now (the schedule calls this once its time comes; Scans has a button for it). */
function resume() {
  const p = pending();
  if (!p) return false;
  setPending(null);
  run(p.task, resumeArg(p.arg), 'resume');
  return true;
}

/** Continue the last stopped run of a task (for a run that stopped before Kea could pause it). */
function resumeLast(task) {
  const last = readJson(activityFile(), []).find((e) => e.task === task);
  run(task, resumeArg(last?.arg || ''), 'resume');
  return true;
}

/** A run that stopped at a usage limit before Kea could pause runs (v0.21) gets picked up the same way. */
function adoptStopped() {
  if (pending()) return;
  const last = readJson(activityFile(), [])[0];
  if (!last || last.ok || last.paused || !LIMIT.test(last.summary || '')) return;
  const until = resetTime(last.summary, new Date(last.end || last.start));
  last.paused = until.toISOString();
  saveActivity(last);
  setPending({ task: last.task, arg: last.arg || '', label: last.label, until: until.toISOString() });
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
  // While paused for a usage limit, scheduled runs wait (they'd only hit the same limit). Runs the student starts still go.
  const p = pending();
  if (p && job.why === 'schedule' && new Date(p.until) > new Date()) {
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
    // One connection file per run: a finished run's cleanup must never delete the next run's file.
    const cfg = path.join(cwd, 'data', `kea-mcp-${entry.id}.json`);
    fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { kea: { type: 'http', url: server.url, headers: { Authorization: `Bearer ${server.token}` } } } }));
    const log = path.join(cwd, 'data', 'logs', `kea-${job.task}-${entry.start.slice(0, 10)}.log`);
    fs.mkdirSync(path.dirname(log), { recursive: true });
    const out = fs.createWriteStream(log, { flags: 'a' });
    out.write(`\n=== ${entry.start} ${job.task} ${job.arg} (${job.why}) ===\n`);
    // Scans always run on Opus (the user's choice: accuracy over usage), whatever Claude Code's own default is.
    const args = ['-p', t.prompt(job.arg), '--model', 'opus', '--output-format', 'stream-json', '--verbose', '--mcp-config', cfg, '--strict-mcp-config', '--permission-mode', 'dontAsk', '--allowedTools', ...t.tools];
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
      fs.rmSync(cfg, { force: true });
      const text = String(result?.result || '');
      if (LIMIT.test(text)) {
        // Out of Claude usage: everything saved so far stays; continue once the limit resets.
        const until = resetTime(text);
        const at = until.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        entry.paused = until.toISOString();
        setPending({ task: job.task, arg: job.arg, label: t.label, until: until.toISOString() });
        if (Notification.isSupported()) new Notification({ title: 'Class scan paused', body: `Your Claude usage limit was reached. Kea continues where it stopped at ${at}.` }).show();
        finish(false, `Paused: your Claude usage limit was reached. Everything found so far is saved, and Kea continues where it stopped at ${at}.`);
      } else if (result && !result.is_error) finish(true, text.trim().slice(0, 4000) || 'Done.');
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

module.exports = { run, stop, status, activity, news, markNewsRead, pending, resume, resumeLast, resetTime, adoptStopped, TASKS };
