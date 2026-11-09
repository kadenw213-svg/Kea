// A stand-in for Claude Code in stream-json mode (never the real one): reads the one user message from stdin, notes
// its arguments and message in FAKE_CLAUDE_LOG (one JSON line per run), then writes a lesson as Claude Code would:
// an init event, text deltas, the assistant message, and a result with usage and modelUsage. FAKE_CLAUDE_DELAY (ms)
// waits between pieces; FAKE_CLAUDE_FAIL makes the result an error with that text (a usage limit, a signed-out Claude, anything).
const fs = require('fs');

const args = process.argv.slice(2);
const model = args[args.indexOf('--model') + 1] || 'unknown';
const delay = Number(process.env.FAKE_CLAUDE_DELAY) || 0;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (ev) => process.stdout.write(`${JSON.stringify(ev)}\n`);

let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', async () => {
  let message = '';
  try {
    message = JSON.parse(input.split('\n')[0]).message.content[0].text;
  } catch {}
  if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ args, message })}\n`);
  out({ type: 'system', subtype: 'init', session_id: 'fake-session', model });
  const pieces = ['## Neutral water\n', 'Pure water has equal H+ and OH-, ', 'so its pH is 7.\n\n### Remember\nNeutral means 7 at 25 C.\n', '```check\n[{"q":"pH of 0.1 M HCl?","choices":["1","7","13"],"answer":0,"why":"Strong acid."}]\n```'];
  for (const p of process.env.FAKE_CLAUDE_FAIL ? [] : pieces) {
    if (delay) await wait(delay);
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: p } }, session_id: 'fake-session' });
  }
  if (!process.env.FAKE_CLAUDE_FAIL) out({ type: 'assistant', message: { model, role: 'assistant', content: [{ type: 'text', text: pieces.join('') }] }, session_id: 'fake-session' });
  const usage = { input_tokens: 1200, output_tokens: 640, cache_read_input_tokens: 3000, cache_creation_input_tokens: 450 };
  out({
    type: 'result', subtype: process.env.FAKE_CLAUDE_FAIL ? 'error_during_execution' : 'success', is_error: !!process.env.FAKE_CLAUDE_FAIL,
    result: process.env.FAKE_CLAUDE_FAIL || pieces.join(''), session_id: 'fake-session', num_turns: 1, total_cost_usd: 0.01, usage,
    modelUsage: { [model]: { inputTokens: 1200, outputTokens: 640, cacheReadInputTokens: 3000, cacheCreationInputTokens: 450, webSearchRequests: 0, costUSD: 0.01 } },
  });
});
