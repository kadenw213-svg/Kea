// A shared-Claude job's run on the owner's API credits: the same run runner.cjs starts with the claude command, through
// the Claude Agent SDK with the owner's API key instead (backend.cjs). Only in a worker copy, only for a job the account
// server handed out on API credits.
//
// Everything that makes a run safe stays the same, option for option with runner.cjs claudeArgs():
//   the locked model, the prompt (or the conversation it continues), Kea's MCP server and no other (strictMcpConfig),
//   only the workspace's project settings (its CLAUDE.md and skills, never ~/.claude), no hooks, the step cap, dontAsk
//   with the task's allowed tools and the same deny list, Claude Code's own system prompt and tools, and the run's
//   minimal environment (runEnv) plus the API key and nothing else.
//
// What comes back looks like the claude command's: an object with stdout (one stream-json line per SDK message, the
// same messages the command prints), stderr, 'error' and 'close' events and kill(), so runner.cjs reads its progress,
// result and usage exactly as before. A billing error (backend.cjs isBillingMessage) is marked on it (billing: true).
// The key never reaches stdout, stderr or the run log: every line is redacted first.
const { EventEmitter } = require('events');
const path = require('path');
const { isBillingMessage, redact } = require('./backend.cjs');

let sdkOverride = null;
/** Tests: a stand-in for the SDK ({ query }), or null for the real one. */
const useSdk = (sdk) => (sdkOverride = sdk);
const loadSdk = async () => sdkOverride || import('@anthropic-ai/claude-agent-sdk');

/**
 * The Claude Code program inside the SDK's package for this platform, from the unpacked copy in an installed Kea
 * (a program can't be started from inside app.asar). null: let the SDK find it.
 */
function claudeExecutable() {
  try {
    const sdkDir = path.dirname(require.resolve('@anthropic-ai/claude-agent-sdk'));
    const file = path.join(path.dirname(sdkDir), `claude-agent-sdk-${process.platform}-${process.arch}`, process.platform === 'win32' ? 'claude.exe' : 'claude');
    return file.replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked');
  } catch {
    return null;
  }
}

/** The claude command line runner.cjs would use, as Agent SDK options (pure, for tests). */
function optionsFrom(args, { cwd, env, apiKey, abortController, stderr }) {
  const val = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  // (--allowedTools and --disallowedTools take every value up to the next flag.)
  const list = (flag) => {
    const i = args.indexOf(flag);
    if (i < 0) return [];
    const out = [];
    for (let j = i + 1; j < args.length && !String(args[j]).startsWith('--'); j++) out.push(args[j]);
    return out;
  };
  const mcp = JSON.parse(require('fs').readFileSync(val('--mcp-config'), 'utf8'));
  const settings = val('--settings') ? JSON.parse(val('--settings')) : undefined;
  const sources = val('--setting-sources');
  const exe = claudeExecutable();
  return {
    prompt: val('-p'),
    options: {
      model: val('--model'),
      cwd,
      // (Only the run's own environment and the key: never this Kea's, never the owner's Claude sign-in.)
      env: { ...env, ANTHROPIC_API_KEY: apiKey, CLAUDE_AGENT_SDK_CLIENT_APP: 'kea-worker' },
      mcpServers: mcp.mcpServers,
      strictMcpConfig: args.includes('--strict-mcp-config'),
      settingSources: sources ? sources.split(',').filter(Boolean) : [],
      ...(settings ? { settings } : {}),
      maxTurns: Number(val('--max-turns')) || undefined,
      permissionMode: val('--permission-mode') || 'dontAsk',
      allowedTools: list('--allowedTools'),
      disallowedTools: list('--disallowedTools'),
      // Claude Code's own system prompt and tools, as the claude command has them.
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      tools: { type: 'preset', preset: 'claude_code' },
      ...(val('--resume') ? { resume: val('--resume') } : {}),
      ...(exe && require('fs').existsSync(exe) ? { pathToClaudeCodeExecutable: exe } : {}),
      abortController,
      stderr,
    },
  };
}

/**
 * Starts one run: `args` as runner.cjs claudeArgs() makes them, `env` its runEnv(), `apiKey` the owner's key.
 * Returns a child-process-like object (see the top).
 */
function start(args, { cwd, env, apiKey }) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = undefined;
  child.billing = false;
  const abortController = new AbortController();
  child.kill = () => {
    abortController.abort();
    return true;
  };
  const out = (m) => child.stdout.emit('data', `${redact(JSON.stringify(m), apiKey)}\n`);
  const err = (t) => child.stderr.emit('data', redact(t, apiKey));
  (async () => {
    let code = 0;
    try {
      const sdk = await loadSdk();
      const { prompt, options } = optionsFrom(args, { cwd, env, apiKey, abortController, stderr: err });
      let failed = false;
      for await (const m of sdk.query({ prompt, options })) {
        if (isBillingMessage(m)) child.billing = true;
        if (m?.type === 'result' && m.is_error) failed = true;
        out(m);
      }
      code = failed ? 1 : 0;
    } catch (e) {
      // (Stopped: like a killed command, no exit code.)
      if (abortController.signal.aborted || e?.name === 'AbortError') code = null;
      else {
        err(`${e?.message || e}\n`);
        code = 1;
      }
    }
    child.emit('close', code);
  })();
  return child;
}

module.exports = { start, optionsFrom, claudeExecutable, useSdk };
