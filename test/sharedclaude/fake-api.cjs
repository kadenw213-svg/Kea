// A stand-in for the Claude Messages API (never the real one), for a fetch passed to the Anthropic SDK: a streamed
// lesson with usage (the same lesson as fake-claude.cjs writes), or an error answer. Each stand-in keeps the calls it
// got ({ url, headers, body }). Used by test/sharedclaude/backend.test.mjs and the compat cells
// (test/compat/shared-claude-cell.mjs, in Kea and KeaC).
const PIECES = ['## Neutral water\n', 'Pure water has equal H+ and OH-, ', 'so its pH is 7.\n\n### Remember\nNeutral means 7 at 25 C.\n', '```check\n[{"q":"pH of 0.1 M HCl?","choices":["1","7","13"],"answer":0,"why":"Strong acid."}]\n```'];
const USAGE = { input: 912, output: 433 };

const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
function lessonEvents(model = 'claude-sonnet-5-5') {
  return [
    { type: 'message_start', message: { id: 'msg_fake', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: USAGE.input, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ...PIECES.map((t) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: USAGE.input, output_tokens: USAGE.output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    { type: 'message_stop' },
  ];
}
function stand(reply) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), headers: new Headers(init.headers), body: init.body ? JSON.parse(init.body) : null });
    return reply();
  };
  fn.calls = calls;
  return fn;
}
/** Answers with a streamed lesson and its usage. */
const lessonFetch = () => stand(() => new Response(sse(lessonEvents()), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
/** Answers with the API's error (status, type), e.g. 402 billing_error. */
const errorFetch = (status, type, message) => stand(() => new Response(JSON.stringify({ type: 'error', error: { type, message } }), { status, headers: { 'content-type': 'application/json' } }));
const billingFetch = () => errorFetch(402, 'billing_error', 'Your credit balance is too low to access the Claude API.');

module.exports = { PIECES, USAGE, lessonFetch, errorFetch, billingFetch };
