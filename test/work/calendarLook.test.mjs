// With Work on, the Work screen's stylesheet is loaded beside the calendar's. Its class names must not be the calendar's,
// or the calendar's events lose their color and shape (Work's ".wk-chip" pill once replaced the calendar's event chip).
// Run: node --test test/work/calendarLook.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([a-z]:)/i, '$1'));
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

/** Every class a stylesheet's rules style, by the first class of each compound selector (".a.b .c" gives a and c). */
function baseClasses(css) {
  const out = new Set();
  const selectors = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{[^{}]*\}/g, '\n').split(/[\n,]/);
  for (const s of selectors) for (const part of s.trim().split(/[\s>+~]+/)) {
    const m = /^[a-z*]*\.([\w-]+)/i.exec(part);
    if (m) out.add(m[1]);
  }
  return out;
}

const work = baseClasses(read('src/components/work/work.css'));
const calendar = baseClasses(read('src/styles/scholar.css'));

test('the Work stylesheet styles none of the calendar’s own classes', () => {
  // (Kea-wide classes like .btn and .input are styled with a Work-only class beside them, never on their own.)
  const shared = [...work].filter((c) => calendar.has(c) && /^(wk|cal|sch|mo|day)-/.test(c));
  assert.deepEqual(shared, []);
});

test('calendar event chips keep their class and color whatever their source', () => {
  const src = read('src/components/scholar/ScholarScreen.tsx');
  // The week view's event chip: its color comes from --kc, set on every item the same way.
  assert.match(src, /className=\{`wk-chip [^`]*`\} style=\{\{ \['--kc' as any\]: ctx\.colors\.item\(i\) \}\}/);
  assert.ok(calendar.has('wk-chip'));
  assert.ok(!work.has('wk-chip'), 'work.css must not restyle the calendar chip');
  for (const f of fs.readdirSync(path.join(root, 'src/components/work')).filter((x) => x.endsWith('.tsx')))
    assert.doesNotMatch(read(`src/components/work/${f}`), /\bwk-chip\b(?!-)/, `${f} uses the calendar's chip class`);
});

