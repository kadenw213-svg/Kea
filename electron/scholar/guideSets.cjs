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
// every one of those sheets. None while a set for that test was just made (by the depth review, an instructor hint or
// the student) or is still being made: the new material waits, still new, until then.
//
// Every quiz and exam gets its review (the owner's rule, 2026-11-28): a test with no review material at all still
// gets one set, written from its chapters' objectives, the syllabus and everything else Kea knows (key `test|<id>`).
// Material only counts as seen once its set was really made: a set that failed gives its material back, tried again
// after RETRY_MS. A document counts by name and size, so a re-uploaded study guide with new content is new.

const DAYS = 30;
const GAP_MS = 12 * 36e5;
const RETRY_MS = 6 * 36e5;
// New sets per class per pass (the pass runs hourly): a class added with many tests gets them over a few hours.
const PER_PASS = 2;
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

/**
 * Every piece of review material for a test, as stable keys. A document (PDF, Word, slides) counts by name and the
 * document's size (`docBytes`, the same for its text copy), so a re-upload with new content is new; a page counts by
 * name only, since a re-synced page changes size without the teacher adding anything.
 */
function materialOf(test, files) {
  const keys = new Set();
  for (const l of test.review_links || []) if (l.url && !NOT_LINK.test(l.url) && !NOT_SHEET.test(l.label || '')) keys.add(`link|${l.url}`);
  for (const f of test.study_focus || []) if (String(f).trim()) keys.add(`focus|${String(f).trim().toLowerCase()}`);
  for (const f of files) {
    const name = String(f.path || f).replace(/\.(pdf|docx|pptx)\.txt$/i, '.$1');
    if (!fileFits(name, test)) continue;
    const size = /\.(pdf|docx|pptx)$/i.test(name) && Number(f.docBytes ?? f.bytes) > 0 ? `|${Number(f.docBytes ?? f.bytes)}` : '';
    keys.add(`file|${name}${size}`);
  }
  return [...keys];
}

/** Seen before: the same key, or (a document) the same name recorded before Kea kept sizes. */
const isSeen = (k, old) => old.includes(k) || (/^file\|.*\|\d+$/.test(k) && old.includes(k.replace(/\|\d+$/, '')));

/**
 * Which tests get a set now. `tests`: the class's tests ({id, title, type, date, chapters, review_links, study_focus});
 * `files`: classFiles(); `seen`: {testId: {keys, prior, at, setId}}; `sets`: study.list() entries. Returns
 * { make: [{test, fresh, record}], seen }. Nothing is marked seen here for a set still to make: the caller saves each
 * `record` (with the set's id, record()) once the set was asked for. Seen gets only tidy-ups: a test that already has
 * a set counts its `test|<id>` key as seen.
 */
function plan({ tests, files, seen = {}, sets = [], now = Date.now() }) {
  const today = new Date(now).toISOString().slice(0, 10);
  const next = { ...seen };
  const make = [];
  const upcoming = (tests || []).filter((t) => {
    const day = String(t.date || '').slice(0, 10);
    return day && day >= today && (Date.parse(day) - now) / 864e5 <= DAYS;
  });
  for (const t of upcoming.sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
    const keys = [`test|${t.id}`, ...materialOf(t, files || [])];
    const old = seen[t.id] || { keys: [], at: 0 };
    const mine = (sets || []).filter((s) => s.itemId === t.id);
    // The set made for the last new material failed or was deleted: that material was never used, so it's new again.
    const last = old.setId ? mine.find((s) => s.id === old.setId) : null;
    const lost = !!old.setId && (!last || last.status === 'failed');
    let had = lost ? old.prior || [] : old.keys || [];
    // (A test that already has a working set, from anywhere, has its review: only new material makes another.)
    if (mine.some((s) => s.status !== 'failed') && !had.includes(`test|${t.id}`)) {
      had = [...had, `test|${t.id}`];
      if (!lost) next[t.id] = { ...old, keys: had };
    }
    const fresh = keys.filter((k) => !isSeen(k, had));
    if (!fresh.length) continue;
    // (Waits while a set for the test is being made or was just made, and after a failure; the material stays new.)
    if (mine.some((s) => s.status === 'making')) continue;
    if (mine.some((s) => s.status !== 'failed' && now - Date.parse(s.createdAt || 0) < GAP_MS)) continue;
    if (lost && now - (old.at || 0) < RETRY_MS) continue;
    if (make.length >= PER_PASS) continue;
    make.push({ test: t, fresh, record: { keys: [...new Set([...had, ...keys])], prior: had, at: now } });
  }
  return { make, seen: next };
}

/** Seen, with one set's material recorded under the set that uses it. */
const record = (seen, testId, rec, setId) => ({ ...seen, [testId]: { ...rec, setId } });

/** How big a test's review is: a quiz a short one, an exam a full one (more chapters, more questions). */
function countFor(test) {
  const n = (test.chapters || []).length;
  return test.type === 'quiz' ? Math.min(30, 15 + 5 * n) : Math.min(50, 20 + 5 * n);
}

/** A news line for a set made from new material (or, with only the test itself new, its first review). */
function newsFor(code, test, fresh) {
  const material = fresh.filter((k) => !k.startsWith('test|'));
  if (!material.length)
    return {
      course: code,
      kind: 'study',
      title: `${code}: a review for ${test.title}`,
      body: `Kea is making a review for ${test.title} from what the class covers before it (its chapters' objectives, the syllabus and the class's material). When your teacher posts a study guide or review, Kea adds questions from it. It's in Study, under ${code}'s tests.`
    };
  const what = material.map((k) => (k.startsWith('file|') ? k.slice(5).replace(/\|\d+$/, '').split('/').pop() : k.startsWith('focus|') ? 'the study focus' : 'a review link'));
  const list = [...new Set(what)];
  return {
    course: code,
    kind: 'study',
    title: `${code}: new practice for ${test.title}`,
    body: `Your teacher posted new review material for ${test.title} (${list.slice(0, 4).join(', ')}${list.length > 4 ? ', …' : ''}). Kea is making practice from it; it's in Study, under ${code}'s tests.`
  };
}

module.exports = { plan, record, countFor, newsFor, _test: { fileFits, materialOf, testWords, isSeen } };
