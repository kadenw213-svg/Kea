// The Claude Assistant: a sidebar in every editor that talks to Claude with the student's own Anthropic API key.
// The key is kept here, in the main process, encrypted with Windows' own keychain (safeStorage), and sent only to
// api.anthropic.com. The window runs the conversation (it holds the editors' tools); each turn of it is one streamed
// request made here, with its text, reasoning summary and tool calls passed back as they arrive.
const { app, ipcMain, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const keyFile = () => path.join(app.getPath('userData'), 'assistant-key.bin');
const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'];
// The models whose refusals can be re-run on another model inside the same request (server-side fallback).
const FALLBACK = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1']);

function readKey() {
  try {
    const raw = fs.readFileSync(keyFile());
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8');
  } catch {
    return '';
  }
}
function writeKey(key) {
  if (!key) return fs.rmSync(keyFile(), { force: true });
  fs.writeFileSync(keyFile(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(key) : Buffer.from(key, 'utf8'));
}
const client = (key = readKey()) => new Anthropic({ apiKey: key, maxRetries: 2 });

/** What went wrong, in words the student can act on. */
function explain(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'Claude didn’t accept your API key. Check it in the Assistant’s settings (console.anthropic.com → API keys).';
  if (err instanceof Anthropic.PermissionDeniedError) return 'Your API key isn’t allowed to use this model. Pick another model in the Assistant’s settings.';
  if (err instanceof Anthropic.NotFoundError) return 'Claude doesn’t know that model. Pick another one in the Assistant’s settings.';
  if (err instanceof Anthropic.RateLimitError) return 'Claude says you’ve hit your rate or spending limit. Wait a minute, or check your limits at console.anthropic.com.';
  if (err instanceof Anthropic.BadRequestError) {
    const m = String(err.message || '');
    if (/credit balance/i.test(m)) return 'Your Anthropic account is out of credit. Add some at console.anthropic.com → Billing.';
    return `Claude couldn’t take that request: ${m.replace(/^\d+\s*/, '').slice(0, 300)}`;
  }
  if (err instanceof Anthropic.InternalServerError) return 'Claude is having trouble right now (a server error). Try again in a moment.';
  if (err instanceof Anthropic.APIConnectionError) return 'Kea couldn’t reach Claude. Check your internet connection.';
  if (err instanceof Anthropic.APIUserAbortError) return '';
  return String(err?.message || err);
}

const running = new Map();
// Developer aid: KEA_ASSISTANT_FAKE=script.cjs answers each turn from a script ({ messages, tools } → a message, with
// events sent as it goes), so the panel and the editors' tools can be tested without an API key or any cost.
const fake = process.env.KEA_ASSISTANT_FAKE ? require(path.resolve(process.env.KEA_ASSISTANT_FAKE)) : null;

function register() {
  ipcMain.handle('assistant:status', () => {
    const key = fake ? 'fake-key-test' : readKey();
    return { hasKey: !!key, hint: key ? `…${key.slice(-4)}` : '', models: MODELS };
  });
  // A new key is checked with a free call (looking up a model) before it's kept.
  ipcMain.handle('assistant:set-key', async (_e, key) => {
    key = String(key || '').trim();
    if (!key) {
      writeKey('');
      return { ok: true };
    }
    try {
      await client(key).models.retrieve('claude-opus-5-5');
      writeKey(key);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: explain(err) };
    }
  });

  // One turn of the conversation, streamed: { model, effort, system, messages, tools }. Events go back to the window as
  // 'assistant:event' { id, type: 'text' | 'thinking' | 'tool', ... }; the promise resolves with the finished message.
  ipcMain.handle('assistant:send', async (e, id, req) => {
    if (fake) return fake(req, (ev) => e.sender.send('assistant:event', { id, ...ev }));
    const key = readKey();
    if (!key) return { error: 'Add your Claude API key first.' };
    const wc = e.sender;
    const send = (ev) => !wc.isDestroyed() && wc.send('assistant:event', { id, ...ev });
    const model = MODELS.includes(req.model) ? req.model : MODELS[0];
    const params = {
      model,
      max_tokens: 64000,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: req.effort || 'medium' },
      // The system prompt, tools and conversation so far are cached, so each new turn pays full price only for what's new.
      cache_control: { type: 'ephemeral' },
      system: req.system,
      tools: (req.tools || []).map((t) => ({ ...t, eager_input_streaming: true })),
      messages: req.messages
    };
    if (FALLBACK.has(model)) Object.assign(params, { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
    try {
      const stream = client(key).beta.messages.stream(params);
      running.set(id, stream);
      for await (const ev of stream) {
        if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use') send({ type: 'tool', name: ev.content_block.name });
        else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') send({ type: 'text', text: ev.delta.text });
        else if (ev.type === 'content_block_delta' && ev.delta.type === 'thinking_delta') send({ type: 'thinking', text: ev.delta.thinking });
      }
      const msg = await stream.finalMessage();
      return { content: msg.content, stop_reason: msg.stop_reason, usage: msg.usage, model: msg.model };
    } catch (err) {
      // A tool's input that couldn't be read at all (not an API error): the window sends the turn again.
      if (!(err instanceof Anthropic.APIError) && !(err instanceof Anthropic.APIUserAbortError) && /json/i.test(String(err?.message))) return { retry: true };
      return { error: explain(err), stopped: err instanceof Anthropic.APIUserAbortError };
    } finally {
      running.delete(id);
    }
  });
  // What part of the window looks like (an editor's area), for Claude to see: at most 1568 px on the long side.
  ipcMain.handle('assistant:capture', async (e, rect) => {
    // The page's CSS pixels, scaled by Kea's zoom (Settings → Appearance → Size of everything) to the window's own units.
    const z = e.sender.getZoomFactor();
    const r = { x: Math.round(rect.x * z), y: Math.round(rect.y * z), width: Math.max(1, Math.round(rect.width * z)), height: Math.max(1, Math.round(rect.height * z)) };
    let img = await e.sender.capturePage(r);
    const { width, height } = img.getSize();
    const k = Math.min(1, 1568 / Math.max(width, height));
    if (k < 1) img = img.resize({ width: Math.round(width * k), height: Math.round(height * k), quality: 'good' });
    return { dataUrl: img.toDataURL(), width: img.getSize().width, height: img.getSize().height };
  });
  ipcMain.handle('assistant:stop', (_e, id) => {
    running.get(id)?.abort();
    return true;
  });
}

module.exports = { register };
