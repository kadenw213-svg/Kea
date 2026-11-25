// The Claude panel's token cuts (Kea 0.107): the trimmed conversation (src/lib/compactHistory.ts), long documents read
// by parts (partsOf in editorTools.ts), and a benchmark estimate of what a 10-message writing session sends.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
let C;
before(async () => {
  const out = path.join(os.tmpdir(), `kea-compact-${process.pid}.cjs`);
  await require('esbuild').build({ entryPoints: [path.resolve(here, '../../src/lib/compactHistory.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
  C = require(out);
});

const PAPER = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1} of the paper. `.repeat(18)).join('\n\n'); // ~25k characters
let n = 0;
const use = (name, input = {}) => ({ type: 'tool_use', id: `t${++n}`, name, input });
const result = (u, content) => ({ type: 'tool_result', tool_use_id: u.id, content });
/** One student message and Claude's steps: read the paper, look, make two edits, answer. */
function turn(msgs, ask, { look = true } = {}) {
  msgs.push({ role: 'user', content: [{ type: 'text', text: ask }] });
  const r = use('read_document');
  msgs.push({ role: 'assistant', content: [{ type: 'thinking', thinking: 'Plan the edit. '.repeat(40), signature: 'sig' }, r] });
  msgs.push({ role: 'user', content: [result(r, PAPER)] });
  if (look) {
    const l = use('look');
    msgs.push({ role: 'assistant', content: [l] });
    msgs.push({ role: 'user', content: [result(l, [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } }, { type: 'text', text: 'Picture of the document.' }])] });
  }
  const e = use('apply_edits', { edits: [{ tool: 'replace_text' }] });
  msgs.push({ role: 'assistant', content: [e] });
  msgs.push({ role: 'user', content: [result(e, 'Done: 2 edits.')] });
  msgs.push({ role: 'assistant', content: [{ type: 'text', text: 'I tightened the second paragraph and fixed the citation.' }] });
}
/** What a whole session sends: every step re-sends the conversation so far (trimmed or not). */
function sessionChars(turns, trim) {
  const msgs = [];
  let sent = 0;
  for (let t = 0; t < turns; t++) {
    const before = msgs.length;
    turn(msgs, `Message ${t + 1}: improve the next part.`);
    // Each assistant message in this turn was one API call, sent everything before it.
    for (let i = before; i < msgs.length; i++) if (msgs[i].role === 'assistant') sent += C.sizeOf(trim ? C.compactHistory(msgs.slice(0, i)) : msgs.slice(0, i));
  }
  return sent;
}

test('earlier turns: long tool results and pictures become one line; thinking goes; the student’s words and Claude’s answers stay', () => {
  const msgs = [];
  turn(msgs, 'First, fix my intro.');
  turn(msgs, 'Now the conclusion.');
  const out = C.compactHistory(msgs);
  const start = C.lastTurnStart(msgs);
  assert.equal(msgs[start].content[0].text, 'Now the conclusion.');
  // Turn 1: the read is a note, the picture is a note, the thinking is gone.
  assert.match(out[2].content[0].content, /Trimmed to save space: the result of read_document \(\d[\d,]* characters\)/);
  assert.match(out[4].content[0].content, /A picture from look was here/);
  assert.ok(!out[1].content.some((b) => b.type === 'thinking'));
  assert.equal(out[1].content[0].type, 'tool_use', 'the call itself stays, so every result still has its call');
  assert.equal(out[6].content[0].content, 'Done: 2 edits.', 'short results stay');
  assert.equal(out[7].content[0].text, 'I tightened the second paragraph and fixed the citation.');
  // The turn in progress is untouched.
  assert.deepEqual(out.slice(start), msgs.slice(start));
  // The stored conversation isn't changed.
  assert.equal(msgs[2].content[0].content, PAPER);
});

test('in the turn in progress, an older read of the same thing is replaced by the newer one; other reads stay', () => {
  const msgs = [{ role: 'user', content: 'Rewrite part 2 then check it.' }];
  const a = use('read_document');
  msgs.push({ role: 'assistant', content: [a] }, { role: 'user', content: [result(a, PAPER)] });
  const b = use('read_document', { parts: [2] });
  msgs.push({ role: 'assistant', content: [b] }, { role: 'user', content: [result(b, PAPER.slice(0, 5000))] });
  const c = use('read_document');
  msgs.push({ role: 'assistant', content: [c] }, { role: 'user', content: [result(c, PAPER)] });
  const out = C.compactHistory(msgs);
  assert.match(out[2].content[0].content, /Replaced by a newer read below/);
  assert.equal(out[4].content[0].content.length, 5000, 'a different read (part 2) stays');
  assert.equal(out[6].content[0].content, PAPER, 'the newest whole read stays');
});

test('a conversation with nothing to trim comes back as it was', () => {
  const msgs = [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] }, { role: 'user', content: 'Thanks' }];
  assert.deepEqual(C.compactHistory(msgs), msgs);
});

test('benchmark: a 10-message writing session on a ~4,000-word paper sends far less', () => {
  const before = sessionChars(10, false);
  const after = sessionChars(10, true);
  const saved = 1 - after / before;
  console.log(`  10 messages: ${Math.round(before / 4).toLocaleString()} → ${Math.round(after / 4).toLocaleString()} tokens sent (about ${Math.round(saved * 100)}% less)`);
  assert.ok(saved >= 0.6, `expected at least 60% less, got ${Math.round(saved * 100)}%`);
});

test('a long document’s parts: a new part at each heading, body text grouped, no headings split by size', async () => {
  const out = path.join(os.tmpdir(), `kea-parts-${process.pid}.cjs`);
  await require('esbuild').build({ entryPoints: [path.resolve(here, '../../src/lib/docParts.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
  const { partsOf, words } = require(out);
  const p = (i, text) => ({ label: `Paragraph ${i}`, text });
  const parts = partsOf([{ label: 'Introduction', text: 'Introduction' }, p(2, 'One.'), p(3, 'Two.'), { label: 'Method', text: 'Method' }, p(5, 'Three.')]);
  assert.deepEqual(parts.map((x) => x.title), ['Introduction', 'Method']);
  assert.equal(parts[0].text, 'Introduction\n\nOne.\n\nTwo.');
  const plain = partsOf(Array.from({ length: 30 }, (_, i) => p(i + 1, 'word '.repeat(200))));
  assert.ok(plain.length >= 5 && plain.length <= 7, `about 5,000 characters a part (got ${plain.length})`);
  assert.equal(words('a b  c\nd'), 4);
});
