// A new study guide for a test makes practice for that test (Settings → Study, scholar.guideSets).
//
// The depth review (runner.cjs) only writes a set where a chapter falls short of new material, only for chapters
// tied to a textbook, and only sees class files named by chapter number. A "Midterm Study Guide.pdf" or a final's
// review sheet slipped past all three. Here, Kea's own check (no Claude): for every test in the next three weeks,
// its review material is everything the teacher posted for it:
//   - links on the test itself (study guide, review sheet, answer key),
//   - its study focus,
//   - class files that look like review material and name the test ("Midterm", "Final", "Exam 2") or one of its
//     chapters.
// Anything Kea hasn't seen for that test before makes one new practice set on the test, whose brief already reads
// every one of those sheets. Never more than one set per test every two days, and none when a set for that test was
// just made (by the depth review, an instructor hint or the student).

const DAYS = 21;
const GAP_MS = 2 * 864e5;
const SHEET = /fun ?sheet|study guide|review|practice (exam|test|problems)|answer key|\bkey\b|worksheet|objectives|exam prep|test prep/i;
const NOT_SHEET = /periodic table|conversion|formula sheet|discussion|dropbox|syllabus|calendar|schedule|announcement/i;
// Links on a test that are the class site's own tools, not material: a quiz's results page, a tool launch, a dropbox.
const NOT_LINK = /quiz_summary|\/quizzing\/|quickLink\.d2l|type=lti|\/dropbox\/|\/discussions?\//i;
const chapterNum = (s) => (/(?:ch(?:apter)?\.?\s*)(\d+)/i.exec(s) || [])[1];

/** Which test a file names: "midterm", "final", or "exam/test 2" (null: none in particular). */
// (Schools name tests every way: "Exam 2", "Exam II", "Test #2", "Unit 3 Test", "Module 4 Exam", "Lab Practical II",
// "Midterm 1", "Final". Roman numerals count as numbers; "unit", "module" and "chapter-set" names say which unit.)
const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
const num = (s) => (/^\d+$/.test(s) ? String(Number(s)) : ROMAN[s] ? String(ROMAN[s]) : null);
function testWords(s) {
  const t = String(s).toLowerCase().replace(/[_\-–]+/g, ' ');
  const out = [];
  const midterm = /mid ?term/.exec(t);
  if (midterm) {
    const n = /mid ?term\s*#?\s*(\d+|[ivx]+)\b/.exec(t);
    out.push(n && num(n[1]) ? `midterm ${num(n[1])}` : 'midterm');
  }
  if (/\bfinal\b/.test(t)) out.push('final');
  const NUM = '#?\\s*(\\d+|i{1,3}|iv|vi{0,3}|ix|x)\\b';
  for (const m of t.matchAll(new RegExp(`\\b(exam|test|practical|quiz)\\s*${NUM}`, 'g'))) if (num(m[2])) out.push(`${m[1] === 'test' ? 'exam' : m[1]} ${num(m[2])}`);
  for (const m of t.matchAll(new RegExp(`\\b(unit|module)\\s*${NUM}`, 'g'))) if (num(m[2])) out.push(`unit ${num(m[2])}`);
  return [...new Set(out)];
}

/** Does this class file belong to this test: it names the test, or (unnamed) one of the test's chapters. */
function fileFits(name, test) {
  const base = String(name).split('/').pop();
  if (!SHEET.test(base) || NOT_SHEET.test(base)) return false;
  const mine = testWords(`${test.title} ${test.type === 'final_exam' ? 'final' : ''} ${test.type === 'midterm' ? 'midterm' : ''}`);
  const named = testWords(base);
  // ("Midterm Study Guide" fits "Midterm 1"; "Midterm 2 Review" doesn't.)
  const fits = (w) => mine.includes(w) || (w === 'midterm' && mine.some((x) => x.startsWith('midterm')));
  if (named.length) return named.some(fits);
  const n = chapterNum(base);
  return !!n && (test.chapters || []).some((c) => chapterNum(c) === n);
}

/** Every piece of review material for a test, as stable keys (a file by name, so its text copy isn't new). */
function materialOf(test, files) {
  const keys = new Set();
  for (const l of test.review_links || []) if (l.url && !NOT_LINK.test(l.url) && !NOT_SHEET.test(l.label || '')) keys.add(`link|${l.url}`);
  for (const f of test.study_focus || []) if (String(f).trim()) keys.add(`focus|${String(f).trim().toLowerCase()}`);
  for (const f of files) {
    const name = String(f.path || f).replace(/\.(pdf|docx|pptx)\.txt$/i, '.$1');
    if (fileFits(name, test)) keys.add(`file|${name}`);
  }
  return [...keys];
}

/**
 * Which tests get a set now. `tests`: the class's tests ({id, title, type, date, chapters, review_links, study_focus});
 * `files`: classFiles(); `seen`: {testId: {keys, at}}; `sets`: study.list() entries. Returns { make: [{test, fresh}],
 * seen } (the new seen, which records material for tests that already have a set as seen, so nothing repeats).
 */
function plan({ tests, files, seen = {}, sets = [], now = Date.now() }) {
  const today = new Date(now).toISOString().slice(0, 10);
  const next = { ...seen };
  const make = [];
  for (const t of tests || []) {
    const day = String(t.date || '').slice(0, 10);
    if (!day || day < today || (Date.parse(day) - now) / 864e5 > DAYS) continue;
    const keys = materialOf(t, files || []);
    if (!keys.length) continue;
    const old = seen[t.id] || { keys: [], at: 0 };
    const fresh = keys.filter((k) => !old.keys.includes(k));
    if (!fresh.length) continue;
    const recent = (sets || []).some((s) => s.itemId === t.id && now - Date.parse(s.createdAt || 0) < GAP_MS);
    if (now - (old.at || 0) < GAP_MS && old.at) continue; // (waits; the material stays fresh until then)
    next[t.id] = { keys: [...new Set([...old.keys, ...keys])], at: recent ? old.at || 0 : now };
    if (!recent) make.push({ test: t, fresh });
  }
  return { make, seen: next };
}

/** A news line for a set made from new material. */
function newsFor(code, test, fresh) {
  const what = fresh.map((k) => (k.startsWith('file|') ? k.slice(5).split('/').pop() : k.startsWith('focus|') ? 'the study focus' : 'a review link'));
  const list = [...new Set(what)];
  return {
    course: code,
    kind: 'update',
    title: `${code}: new practice for ${test.title}`,
    body: `Your teacher posted new review material for ${test.title} (${list.slice(0, 4).join(', ')}${list.length > 4 ? ', …' : ''}). Kea is making a practice set from it.`
  };
}

module.exports = { plan, newsFor, _test: { fileFits, materialOf, testWords } };
