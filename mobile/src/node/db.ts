// The class database, as study.cjs asks it things, answered on the phone from the PC's copy (kea-data.json): which
// class and chapters a set is for, and each chapter's next test.
import type { KeaData } from '../kea';

let data: KeaData | null = null;
export function setData(d: KeaData | null) {
  data = d;
}

const TESTS = new Set(['exam', 'final_exam', 'midterm', 'lab_practical', 'quiz']);
const localDay = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export async function courses() {
  return (data?.courses || []).map((c) => ({ ...c }));
}

/** { "courseId|Chapter N": { date, title } }: the next test on each chapter. */
export async function nextTests() {
  const out: Record<string, { date: string; title: string }> = {};
  const today = localDay();
  for (const t of (data?.items || []).filter((i) => TESTS.has(i.type) && i.date >= today).sort((a, b) => a.date.localeCompare(b.date)))
    for (const r of t.readings || []) {
      const key = `${t.courseId}|${r.chapter}`;
      if (!out[key]) out[key] = { date: t.date, title: t.title };
    }
  return out;
}

/** The class, chapters and tests a set is for (the same shape as Kea on the PC gives). */
export async function practiceSources(_db: string, _tb: string, { courseId, chapters = [], itemId = null }: { courseId: string; chapters?: string[]; itemId?: string | null }) {
  if (!data) return null;
  let labels = [...chapters];
  let item = null as null | Record<string, unknown>;
  if (itemId) {
    const it = data.items.find((i) => i.id === itemId);
    if (it) {
      courseId = it.courseId;
      item = { id: it.id, title: it.title, type: it.type, date: it.date, points: it.points, description: it.description, study_focus: it.studyFocus, review_links: [] };
      if (!labels.length) labels = it.readings.map((r) => r.chapter);
    }
  }
  const c = data.courses.find((x) => x.id === courseId || x.code === courseId);
  const detail = data.details.find((d) => d.id === c?.id);
  if (!c || !detail) return null;
  const want = new Set(labels);
  const out = detail.chapters
    .filter((ch) => want.has(ch.label))
    .map((ch) => ({ label: ch.label, title: ch.title, summary: ch.summary, sections: ch.sections, objectives: ch.objectives, vocabulary: ch.vocabulary, reading_url: ch.readingUrl, textbook_source: null, depth_gaps: null, review_links: [] }));
  const tests = data.items
    .filter((i) => i.courseId === c.id && TESTS.has(i.type) && (i.id === itemId || i.readings.some((r) => want.has(r.chapter))))
    .map((i) => ({ id: i.id, title: i.title, type: i.type, date: i.date, chapters: i.readings.map((r) => r.chapter), study_focus: i.studyFocus, description: i.description, review_links: [] }));
  return { course: { id: c.id, code: c.code, name: c.name }, item, chapters: out, tests };
}

export default { setData, courses, nextTests, practiceSources };
