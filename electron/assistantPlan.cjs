// The Claude tab on the student's own Claude plan (Pro / Max) instead of an API key: each message runs Claude Code
// (the official app, signed in with their Claude account) in the background. Claude Code runs the conversation; the
// open file's tools reach it over a private MCP connection pinned to that tab (electron/mcp/server.cjs openInternal),
// so it uses exactly the tools the API route does. Built-in tools are off (no shell, no file access): only Kea's.
// Claude Code reports the plan's 5-hour and weekly usage with every reply; the latest is kept for the usage bars.
const { app, ipcMain } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const workspace = require('./scholar/workspace.cjs');
const control = require('./mcp/server.cjs');

const running = new Map(); // request id -> child process
const cancelled = new Set(); // Stop pressed before Claude Code had started
// The plan, never an API key: if the student has one in their environment, Claude Code would bill it instead.
const planEnv = () => {
  const env = { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'kea', ENABLE_TOOL_SEARCH: 'false' };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
};
const usageFile = () => path.join(app.getPath('userData'), 'plan-usage.json');
// An empty folder to run in, so no project's CLAUDE.md or settings are picked up.
const workDir = () => {
  const d = path.join(app.getPath('userData'), 'claude-tab');
  fs.mkdirSync(d, { recursive: true });
  return d;
};

async function findClaude() {
  if (process.platform === 'win32') return workspace.findClaude();
  const home = os.homedir();
  for (const f of [path.join(home, '.local', 'bin', 'claude'), path.join(home, '.claude', 'local', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']) if (fs.existsSync(f)) return f;
  return null;
}

let lastUsage = null;
function readUsage() {
  if (lastUsage) return lastUsage;
  try {
    lastUsage = JSON.parse(fs.readFileSync(usageFile(), 'utf8'));
  } catch {}
  return lastUsage;
}
/** Keep the plan's latest usage (from Claude Code's rate_limit_event) and tell the window. */
function noteUsage(info, send) {
  const w = info && info.unifiedWindows;
  if (!w) return;
  const pick = (x) => (x ? { used: Number(x.utilization) || 0, resetsAt: x.resetsAt ? x.resetsAt * 1000 : null, status: x.status || '' } : null);
  lastUsage = { fiveHour: pick(w.five_hour), week: pick(w.seven_day), status: info.status || '', at: Date.now() };
  try {
    fs.writeFileSync(usageFile(), JSON.stringify(lastUsage));
  } catch {}
  send('assistant:plan-usage', lastUsage);
}

/** What went wrong, from Claude Code's output, in words the student can act on. */
function explain(text) {
  const t = String(text || '');
  if (/not logged in|please run .*login|invalid api key|authentication|oauth token/i.test(t)) return 'Claude Code isn’t signed in. Use “Sign in to Claude” in the Claude tab (or Settings → Claude Assistant).';
  if (/usage limit|rate limit|limit reached|resets/i.test(t)) return `You’ve reached your Claude plan’s usage limit. ${t.match(/resets?[^.\n]*/i)?.[0] || 'It resets soon.'}`;
  return t.trim().slice(0, 400) || 'Claude Code stopped without answering.';
}

function register({ getWindow }) {
  const send = (channel, payload) => {
    const w = getWindow();
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  };

  ipcMain.handle('assistant:plan-status', async () => {
    const claude = await findClaude();
    const account = claude ? await workspace.claudeAccount(claude) : { loggedIn: false };
    return { installed: !!claude, loggedIn: !!account.loggedIn, email: account.email || '', plan: account.plan || '', method: account.method || '' };
  });
  ipcMain.handle('assistant:plan-signin', async () => {
    if (!(await findClaude())) {
      const r = await workspace.installClaude(() => {});
      if (!(await findClaude())) throw new Error(`Claude Code couldn’t be installed: ${String(r.out || '').slice(-300)}`);
    }
    return workspace.signInClaude();
  });
  ipcMain.handle('assistant:plan-usage-get', () => readUsage());

  /**
   * One message on the plan: { tabId, content (Anthropic content blocks), session (to continue), model, effort,
   * system }. Streams events to the window as 'assistant:plan-event' { id, ev } (Claude Code's own stream-json lines)
   * and resolves when Claude is done: { session, error?, stopped? }.
   */
  ipcMain.handle('assistant:plan-send', async (_e, id, req) => {
    cancelled.delete(id);
    const claude = await findClaude();
    if (!claude) return { error: 'Claude Code isn’t installed. Use “Sign in to Claude” in the Claude tab to set it up.' };
    let conn;
    try {
      conn = await control.openInternal(req.tabId);
    } catch (err) {
      return { error: String(err.message || err) };
    }
    const mcp = JSON.stringify({ mcpServers: { kea: { type: 'http', url: conn.url, headers: { Authorization: `Bearer ${conn.token}` } } } });
    // Only Kea's tools; none of the student's own Claude Code setup (hooks, settings) from their home folder.
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--mcp-config', mcp, '--strict-mcp-config', '--tools', '', '--allowedTools', 'mcp__kea', '--permission-mode', 'dontAsk', '--setting-sources', 'project', '--system-prompt', String(req.system || '')];
    if (req.model) args.push('--model', String(req.model));
    if (req.effort) args.push('--effort', String(req.effort));
    if (req.session) args.push('--resume', String(req.session));
    if (cancelled.delete(id)) {
      conn.close();
      return { session: req.session || null, stopped: true };
    }
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(claude, args, { cwd: workDir(), windowsHide: true, env: planEnv() });
      } catch (err) {
        conn.close();
        return resolve({ error: `Claude Code couldn’t start: ${err.message}` });
      }
      running.set(id, child);
      child.stdin.on('error', () => {}); // it may exit before reading a big message (not signed in, bad flag)
      let session = req.session || null;
      let buf = '';
      let errText = '';
      let result = null;
      const line = (l) => {
        if (!l.trim()) return;
        let ev;
        try {
          ev = JSON.parse(l);
        } catch {
          return;
        }
        if (process.env.KEA_PLAN_LOG) fs.appendFileSync(process.env.KEA_PLAN_LOG, `${l}
`); // developer aid
        if (ev.session_id) session = ev.session_id;
        if (ev.type === 'rate_limit_event') return noteUsage(ev.rate_limit_info, send);
        if (ev.type === 'result') result = ev;
        send('assistant:plan-event', { id, ev });
      };
      child.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          line(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      });
      child.stderr.on('data', (d) => (errText += d));
      child.on('error', (err) => (errText += err.message));
      child.on('close', (code, signal) => {
        if (process.env.KEA_PLAN_LOG) fs.appendFileSync(process.env.KEA_PLAN_LOG, `STDERR ${errText}
ARGS ${JSON.stringify(args)}
`);
        line(buf);
        running.delete(id);
        conn.close();
        const stopped = !!child.killedByUser;
        if (stopped) return resolve({ session, stopped: true });
        if (result && result.is_error) return resolve({ session, error: explain(result.result || (result.errors || []).join('\n') || errText) });
        if (!result && code !== 0) return resolve({ session, error: explain(errText || `Claude Code exited (${signal || code}).`) });
        resolve({ session, usage: result && result.usage, turns: result && result.num_turns });
      });
      // The message goes in as one stream-json line; closing stdin tells Claude Code there's nothing more to say.
      child.stdin.end(`${JSON.stringify({ type: 'user', message: { role: 'user', content: req.content } })}\n`);
    });
  });
  ipcMain.handle('assistant:plan-stop', (_e, id) => {
    const c = running.get(id);
    if (!c) {
      cancelled.add(id);
      return true;
    }
    c.killedByUser = true;
    c.kill();
    return true;
  });

  /** Refresh the usage bars without a conversation: the smallest possible message (a few tokens on Haiku). */
  ipcMain.handle('assistant:plan-usage-refresh', async () => {
    const claude = await findClaude();
    if (!claude) return readUsage();
    await new Promise((resolve) => {
      const child = spawn(claude, ['-p', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--tools', '', '--model', 'haiku', '--no-session-persistence', '--setting-sources', 'project', '--system-prompt', 'Reply with one character.'], { cwd: workDir(), windowsHide: true, env: planEnv() });
      const timer = setTimeout(() => child.kill(), 60000);
      child.on('close', () => clearTimeout(timer));
      child.stdin.on('error', () => {});
      let buf = '';
      child.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          try {
            const ev = JSON.parse(buf.slice(0, i));
            if (ev.type === 'rate_limit_event') noteUsage(ev.rate_limit_info, send);
          } catch {}
          buf = buf.slice(i + 1);
        }
      });
      child.on('close', resolve);
      child.on('error', resolve);
      child.stdin.end('.');
    });
    return readUsage();
  });

  app.on('before-quit', () => {
    for (const c of running.values()) c.kill();
  });
}

module.exports = { register };
