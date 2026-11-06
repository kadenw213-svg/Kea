// The student's own due dates. D2L's data API gives each assignment folder and quiz the class's due date; an
// extension the instructor gives one student ("special access") shows only on the student's own lists: the
// Assignments page and the Quizzes page print "Due on Nov 7, 2026 23:59" with that student's date. The pre-check reads
// both lists, and every folder or quiz whose date there differs from the class's date gets the student's date (the
// class's is kept as KeaGeneralDue), so the calendar moves it and marks it extended.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DUE = /\bDue(?:\s+on|\s+date)?:?\s+(?:[A-Za-z]+,\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})(?:\s+(?:at\s+)?(\d{1,2}):(\d{2})\s*([AaPp]\.?[Mm]\.?)?)?/;

/** Where each list is, and how its rows name their folder or quiz. */
const LISTS = {
  dropbox: { rel: (ou) => `/d2l/lms/dropbox/user/folders_list.d2l?ou=${ou}&isprv=0`, id: /[?&;]db=(\d+)/g },
  quizzes: { rel: (ou) => `/d2l/lms/quizzing/user/quizzes_list.d2l?ou=${ou}`, id: /[?&;]qi=(\d+)/g }
};

const text = (html) =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

/** "Nov 7, 2026 23:59" (or "November 7, 2026 11:59 PM") as a time on this computer's clock, or null. */
function parseDue(s) {
  const m = DUE.exec(s);
  if (!m) return null;
  const mon = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
  if (mon < 0) return null;
  let h = m[4] != null ? Number(m[4]) : 23;
  const min = m[5] != null ? Number(m[5]) : 59;
  const ap = (m[6] || '').toLowerCase().replace(/\./g, '');
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  const d = new Date(Number(m[3]), mon, Number(m[2]), h, min);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * A list page's due date for each folder or quiz it shows: { id: Date }. Each row runs from its first link to the next
 * row's (a row links its name and its status, both with the same id); its due date is the first "Due on" in it.
 */
function parseList(html, kind) {
  const re = new RegExp(LISTS[kind].id.source, 'g');
  const marks = [];
  let m;
  while ((m = re.exec(html))) if (!marks.length || marks[marks.length - 1].id !== m[1]) marks.push({ id: m[1], at: m.index });
  const out = {};
  marks.forEach((x, i) => {
    if (out[x.id]) return;
    const d = parseDue(text(html.slice(x.at, i + 1 < marks.length ? marks[i + 1].at : x.at + 6000)));
    if (d) out[x.id] = d;
  });
  return out;
}

/**
 * The folders or quizzes whose date on the student's list differs from the class's: [{ id, general, personal }]
 * (ISO times). The lists print minutes in the student's site time zone; when that isn't this computer's, every row is
 * off by the same whole hours, so the most common difference is taken as the clock's and only rows apart from it count.
 */
function differences(objects, personal, { idOf, dueOf }) {
  const rows = [];
  for (const o of objects) {
    const p = personal[String(idOf(o))];
    if (!p) continue;
    const g = dueOf(o) ? Date.parse(dueOf(o)) : NaN;
    rows.push({ id: idOf(o), p, g, diff: isNaN(g) ? null : Math.round(p.getTime() / 60e3) - Math.floor(g / 60e3) });
  }
  const counts = new Map();
  for (const r of rows) if (r.diff != null) counts.set(r.diff, (counts.get(r.diff) || 0) + 1);
  let clock = 0;
  let best = 0;
  for (const [d, n] of counts) if (n > best || (n === best && Math.abs(d) < Math.abs(clock))) [clock, best] = [d, n];
  // (One dated row only: a difference of whole hours is as likely the clock as an extension, so it isn't one.)
  if (best < 2 && !(best === 1 && clock === 0)) clock = rows.length === 1 && rows[0].diff % 60 === 0 && Math.abs(rows[0].diff) <= 720 ? rows[0].diff : 0;
  const out = [];
  for (const r of rows) {
    if (r.diff != null && Math.abs(r.diff - clock) < 30) continue;
    const personalAt = new Date(r.p.getTime() - clock * 60e3);
    out.push({ id: r.id, general: isNaN(r.g) ? null : new Date(r.g).toISOString(), personal: personalAt.toISOString() });
  }
  return out;
}

/**
 * Put the student's own dates on a pre-check area's data (D2L's folder or quiz list) in place: DueDate becomes theirs,
 * KeaGeneralDue keeps the class's. `html` is the student's list page. Returns what changed.
 */
function apply(kind, data, html) {
  const personal = parseList(html || '', kind);
  if (!Object.keys(personal).length) return [];
  const list = kind === 'quizzes' ? data?.Objects || [] : Array.isArray(data) ? data : [];
  const idOf = kind === 'quizzes' ? (q) => q.QuizId : (f) => f.Id;
  const dueOf = kind === 'quizzes' ? (q) => q.DueDate || null : (f) => f.DueDate || null;
  const found = differences(list, personal, { idOf, dueOf });
  for (const d of found) {
    const o = list.find((x) => String(idOf(x)) === String(d.id));
    if (!o) continue;
    o.KeaGeneralDue = d.general;
    o.DueDate = d.personal;
  }
  return found;
}

module.exports = { LISTS, parseDue, parseList, differences, apply };
