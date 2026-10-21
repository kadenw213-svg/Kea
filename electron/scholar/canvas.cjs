// Canvas schools: Kea reads Canvas's data API (/api/v1, with the student's own signed-in session) and hands each area to
// the rest of Kea in the shape D2L's API answers it (assignment folders, quizzes, discussion topics, grade values,
// announcements, the content list). Everything after reading (the pre-check, calendar matching, hand-in evidence, the
// Inbox, grades, links) works the same for both platforms, so a fix to one is a fix to both.
//
// Canvas says outright whether each piece of work is submitted or graded (its submission's own state), so nothing here
// guesses: work counts as handed in only when Canvas gives a submission time, and as graded only when it gives a score
// or grade. Fields Kea adds that D2L doesn't have start with "Kea" (KeaUrl: the work's own Canvas page).
const browser = require('./browser.cjs');

const PER = 'per_page=100';
const home = () => browser.schoolInfo().home;
const abs = (u) => {
  try {
    return u ? new URL(u, home()).href : '';
  } catch {
    return '';
  }
};

/**
 * Every page of a Canvas list (it pages with a Link header). { status, data } like browser.getJson; a list that fails
 * after its first page keeps what was read.
 */
async function all(rel, maxPages = 30) {
  const out = [];
  let next = rel;
  for (let i = 0; next && i < maxPages; i++) {
    const r = await browser.getJson(next);
    if (!r.data) return i ? { status: 200, data: out } : r;
    if (!Array.isArray(r.data)) return r;
    out.push(...r.data);
    next = r.next;
  }
  return { status: 200, data: out };
}

/** The signed-in student's Canvas user id (for telling their own posts and messages apart), read once per session. */
let myId = null;
async function me() {
  if (myId) return myId;
  const r = await browser.getJson('/api/v1/users/self').catch(() => null);
  myId = r?.data?.id ? String(r.data.id) : null;
  return myId;
}

// ---------- One class's work, read once per check and shared by every area that needs it ----------
const memo = new Map();
const MEMO_MS = 3 * 60e3;

/** The class's assignments (with the student's own submission) and discussion topics: { status, assignments, topics }. */
async function work(ou) {
  const hit = memo.get(ou);
  if (hit && Date.now() - hit.at < MEMO_MS) return hit.value;
  const value = (async () => {
    const a = await all(`/api/v1/courses/${ou}/assignments?${PER}&include[]=submission&order_by=due_at`);
    if (!a.data) return { status: a.status, assignments: null, topics: [], comments: new Map() };
    // Feedback written on each submission (the assignments list leaves comments out). Optional: without it, grades
    // still come through, just without the instructor's comment.
    const comments = new Map();
    const subs = await all(`/api/v1/courses/${ou}/students/submissions?${PER}&include[]=submission_comments`).catch(() => null);
    const self = await me();
    for (const s of Array.isArray(subs?.data) ? subs.data : []) {
      const list = (s.submission_comments || []).filter((c) => String(c.author_id) !== String(self) && String(c.comment || '').trim());
      if (list.length) comments.set(String(s.assignment_id), list.map((c) => c.comment.trim()).join('\n\n'));
    }
    const t = await all(`/api/v1/courses/${ou}/discussion_topics?${PER}`);
    return { status: 200, assignments: a.data, topics: Array.isArray(t.data) ? t.data : [], comments };
  })();
  memo.set(ou, { at: Date.now(), value });
  value.catch(() => memo.delete(ou));
  return value;
}

const types = (a) => a.submission_types || [];
const toolUrl = (a) => a.external_tool_tag_attributes?.url || '';
/** What kind of Canvas work an assignment is: a quiz (Classic or New Quizzes), a graded discussion, or the rest. */
function kindOf(a) {
  if (types(a).includes('online_quiz') || a.is_quiz_assignment || a.quiz_id || a.is_quiz_lti_assignment || /quiz-lti/i.test(toolUrl(a))) return 'quiz';
  if (types(a).includes('discussion_topic') || a.discussion_topic) return 'discussion';
  return 'folder';
}
const rubric = (a) =>
  Array.isArray(a.rubric) && a.rubric.length
    ? [{ Name: a.rubric_settings?.title || 'Rubric', CriteriaGroups: [{ Criteria: a.rubric.map((c) => ({ Name: c.description || '', Cells: (c.ratings || []).map((r) => ({ Points: r.points, Description: [r.description, r.long_description].filter(Boolean).join(': ') })) })) }] }]
    : [];
/** Canvas's submission, kept as it is: the pre-check reads its own state instead of asking per assignment. */
const submissionOf = (a) => (a.submission ? { workflow_state: a.submission.workflow_state, submitted_at: a.submission.submitted_at || null, score: a.submission.score ?? null, grade: a.submission.grade ?? null, excused: !!a.submission.excused, missing: !!a.submission.missing, late: !!a.submission.late, graded_at: a.submission.graded_at || null, attempt: a.submission.attempt ?? null } : null);

/** An assignment as a D2L assignment folder. */
const folder = (a) => ({
  Id: a.id,
  Name: a.name,
  DueDate: a.due_at || null,
  Availability: { StartDate: a.unlock_at || null, EndDate: a.lock_at || null },
  IsHidden: a.published === false,
  CustomInstructions: { Text: '', Html: a.description || '' },
  Attachments: [],
  LinkAttachments: toolUrl(a) ? [{ LinkName: 'Opens in an outside tool', Href: abs(a.html_url) }] : [],
  ...(types(a).includes('online_upload') ? { SubmissionType: 0 } : {}),
  Assessment: { ScoreDenominator: a.points_possible ?? null, Rubrics: rubric(a) },
  GradeItemId: String(a.id),
  KeaUrl: abs(a.html_url),
  KeaSubmission: submissionOf(a),
  KeaSubmissionTypes: types(a)
});

/** A quiz assignment (or an ungraded Classic quiz) as a D2L quiz. */
const quiz = (ou, a) => ({
  QuizId: a.quiz_id || a.id,
  Name: a.name,
  DueDate: a.due_at || null,
  StartDate: a.unlock_at || null,
  EndDate: a.lock_at || null,
  IsActive: a.published !== false,
  Description: { Text: '', Html: a.description || '' },
  GradeItemId: String(a.id),
  KeaUrl: a.quiz_id ? abs(`/courses/${ou}/quizzes/${a.quiz_id}`) : abs(a.html_url),
  KeaSubmission: submissionOf(a),
  KeaAssignmentId: a.id
});

/** A discussion topic as a D2L topic (Canvas has no forums: every topic is under "Discussion"). */
const topic = (t, a) => ({
  TopicId: t.id,
  ForumId: t.id,
  ForumName: 'Discussion',
  Name: t.title,
  DueDate: a?.due_at ?? t.todo_date ?? null,
  StartDate: t.delayed_post_at ?? a?.unlock_at ?? null,
  EndDate: t.lock_at ?? a?.lock_at ?? null,
  ScoreOutOf: a?.points_possible ?? null,
  GradeItemId: t.assignment_id ? String(t.assignment_id) : null,
  Description: { Text: '', Html: t.message || '' },
  IsHidden: t.published === false,
  KeaUrl: abs(t.html_url),
  KeaSubmission: a ? submissionOf(a) : null,
  KeaRequireInitialPost: !!t.require_initial_post
});

/** An assignment as a D2L grade value (only a real score or grade fills it in; nothing is guessed). */
function gradeValue(a, comments) {
  const s = a.submission || {};
  const shown = s.excused ? 'Excused' : s.grade != null && String(s.grade).trim() ? String(s.grade) : '';
  return {
    GradeObjectIdentifier: String(a.id),
    GradeObjectName: a.name,
    GradeObjectType: 1,
    GradeObjectTypeName: 'Numeric',
    PointsNumerator: s.score ?? null,
    PointsDenominator: a.points_possible ?? null,
    DisplayedGrade: shown,
    Comments: { Text: comments.get(String(a.id)) || '' },
    LastModified: s.graded_at || s.posted_at || null
  };
}

/** The class's modules as D2L's table of contents (modules with topics). */
async function contents(ou, w) {
  const r = await all(`/api/v1/courses/${ou}/modules?${PER}&include[]=items&include[]=content_details`);
  const mods = Array.isArray(r.data) ? r.data : [];
  const out = [];
  for (const m of mods) {
    // (A module with many items leaves them out of the list: they're read on their own.)
    let items = m.items;
    if (!Array.isArray(items)) items = (await all(`/api/v1/courses/${ou}/modules/${m.id}/items?${PER}&include[]=content_details`).catch(() => null))?.data || [];
    out.push({
      ModuleId: m.id,
      Title: m.name,
      IsHidden: m.published === false,
      Topics: items
        .filter((it) => it.type !== 'SubHeader')
        .map((it) => ({
          TopicId: it.id,
          Identifier: String(it.id),
          Title: it.title,
          // A plain link goes where it points; everything else opens through Canvas (an outside tool launches there).
          Url: it.type === 'ExternalUrl' ? it.external_url || it.html_url : abs(it.html_url),
          ActivityType: it.type === 'ExternalTool' ? 7 : it.type === 'ExternalUrl' ? 2 : 1,
          IsHidden: it.published === false,
          // (Only when it opens: a module item's due date is its assignment's, already compared through the assignment.)
          StartDateTime: it.content_details?.unlock_at || m.unlock_at || null,
          EndDateTime: it.content_details?.lock_at || null,
          KeaType: it.type,
          KeaToolUrl: it.type === 'ExternalTool' ? it.external_url || '' : '',
          KeaApiUrl: it.url || '',
          KeaPageUrl: it.page_url || ''
        })),
      Modules: []
    });
  }
  // Work done in an outside tool (ALEKS, Connect…) is often an assignment and nowhere in the modules: listed too, so
  // the class's platforms and their launch links are found the same way.
  const tools = (w.assignments || []).filter((a) => types(a).includes('external_tool') && kindOf(a) !== 'quiz' && a.published !== false);
  if (tools.length) out.push({ ModuleId: 'kea-tools', Title: 'Assignments in outside tools', IsHidden: false, Topics: tools.map((a) => ({ TopicId: `a${a.id}`, Identifier: `a${a.id}`, Title: a.name, Url: abs(a.html_url), ActivityType: 7, IsHidden: false, StartDateTime: null, EndDateTime: null, KeaType: 'Assignment', KeaToolUrl: toolUrl(a) })), Modules: [] });
  if (!r.data && !tools.length) return { status: r.status, data: null };
  return { status: 200, data: { Modules: out } };
}

/**
 * One area of a class, as D2L's API would answer it: { status, data }. A 404 means the area doesn't apply (the
 * pre-check skips it quietly), like a D2L tool a class doesn't use.
 */
async function area(name, ou) {
  if (name === 'news') {
    const r = await browser.getJson(`/api/v1/courses/${ou}/discussion_topics?only_announcements=true&per_page=50`);
    if (!Array.isArray(r.data)) return r;
    const now = Date.now();
    return {
      status: 200,
      data: r.data
        .filter((t) => !(t.delayed_post_at && Date.parse(t.delayed_post_at) > now))
        .map((t) => ({ Id: t.id, Title: t.title, Body: { Text: '', Html: t.message || '' }, StartDate: t.posted_at || t.delayed_post_at || t.created_at || null, CreatedDate: t.created_at || null, LastModifiedDate: t.posted_at || null, IsHidden: false, KeaUrl: abs(t.html_url) }))
    };
  }
  if (name === 'final') {
    const r = await browser.getJson(`/api/v1/courses/${ou}/enrollments?user_id=self&type[]=StudentEnrollment`);
    const g = (Array.isArray(r.data) ? r.data : []).find((e) => e.grades)?.grades;
    // (A class that hides its total shows none.)
    if (!g || g.current_score == null) return { status: 404, data: null };
    return { status: 200, data: { DisplayedGrade: g.current_grade ? `${g.current_grade} (${g.current_score} %)` : `${g.current_score} %`, PointsNumerator: g.current_score, PointsDenominator: 100 } };
  }
  if (name === 'calendar') {
    const from = new Date(Date.now() - 7 * 864e5).toISOString();
    const to = new Date(Date.now() + 240 * 864e5).toISOString();
    const r = await all(`/api/v1/calendar_events?type=event&context_codes[]=course_${ou}&start_date=${from}&end_date=${to}&${PER}`);
    if (!Array.isArray(r.data)) return r;
    return { status: 200, data: r.data.map((e) => ({ CalendarEventId: e.id, Title: e.title, StartDateTime: e.start_at, EndDateTime: e.end_at, Location: e.location_name || '', Description: { Text: '', Html: e.description || '' } })) };
  }
  const w = await work(ou);
  if (name === 'content') return contents(ou, w);
  if (!w.assignments) return { status: w.status, data: null };
  const live = w.assignments.filter((a) => a.published !== false);
  if (name === 'dropbox') return { status: 200, data: live.filter((a) => kindOf(a) === 'folder').map(folder) };
  if (name === 'grades') return { status: 200, data: live.filter((a) => !a.omit_from_final_grade || a.submission?.score != null).map((a) => gradeValue(a, w.comments)) };
  if (name === 'quizzes') {
    const objects = live.filter((a) => kindOf(a) === 'quiz').map((a) => quiz(ou, a));
    // Ungraded practice quizzes (Classic) aren't assignments: listed from the quizzes themselves.
    const q = await all(`/api/v1/courses/${ou}/quizzes?${PER}`).catch(() => null);
    const graded = new Set(objects.map((o) => String(o.QuizId)));
    for (const x of Array.isArray(q?.data) ? q.data : [])
      if (!x.assignment_id && x.published !== false && !graded.has(String(x.id)))
        objects.push({ QuizId: x.id, Name: x.title, DueDate: x.due_at || null, StartDate: x.unlock_at || null, EndDate: x.lock_at || null, IsActive: true, Description: { Text: '', Html: x.description || '' }, GradeItemId: null, KeaUrl: abs(x.html_url), KeaSubmission: null, KeaPractice: true });
    return { status: 200, data: { Objects: objects, Next: null } };
  }
  if (name === 'discussions') {
    const byId = new Map(w.assignments.map((a) => [String(a.id), a]));
    return { status: 200, data: w.topics.map((t) => topic(t, t.assignment_id ? byId.get(String(t.assignment_id)) : null)) };
  }
  return { status: 404, data: null };
}

/**
 * The student's posts in a topic, as D2L's posts list: [{ PostingUserId, ParentPostId }]. A topic that needs the
 * student's first post before it shows others (Canvas answers 403) means they haven't started it: []. Null when
 * unreadable.
 */
async function topicPosts(ou, topicId) {
  const flat = [];
  const walk = (list, parent) => {
    for (const e of list || []) {
      if (e.deleted) continue;
      flat.push({ PostingUserId: String(e.user_id ?? ''), ParentPostId: parent ?? e.parent_id ?? null });
      walk(e.replies, e.id);
      walk(e.recent_replies, e.id);
    }
  };
  const v = await browser.getJson(`/api/v1/courses/${ou}/discussion_topics/${topicId}/view`).catch(() => null);
  if (v?.status === 403) return [];
  if (v?.data && Array.isArray(v.data.view)) {
    walk(v.data.view, null);
    return flat;
  }
  // (The full view is built in the background on a busy topic: the entries list, with each entry's recent replies.)
  const e = await all(`/api/v1/courses/${ou}/discussion_topics/${topicId}/entries?${PER}`, 5).catch(() => null);
  if (e?.status === 403) return [];
  if (!Array.isArray(e?.data)) return null;
  walk(e.data, null);
  return flat;
}

/**
 * The classes the student is enrolled in now, as D2L's enrollments list (the engine decides which are real classes
 * not yet in Kea).
 */
async function enrollments() {
  const r = await all(`/api/v1/courses?enrollment_state=active&enrollment_type=student&include[]=term&${PER}`);
  if (!Array.isArray(r.data)) return null;
  return r.data
    .filter((c) => c && c.id && !c.access_restricted_by_date)
    .map((c) => ({
      OrgUnit: { Id: c.id, Name: c.name || '', Code: c.course_code || '', Type: { Id: 3 } },
      Access: { StartDate: c.start_at || c.term?.start_at || null, EndDate: c.end_at || c.term?.end_at || null, IsActive: c.workflow_state !== 'completed', CanAccess: true },
      KeaPlatform: 'canvas',
      KeaHomePath: `/courses/${c.id}`,
      KeaTerm: c.term?.name || ''
    }));
}

// ---------- Messages: Canvas's Inbox (conversations) ----------
const conversationId = (url) => (/\/conversations\/(\d+)/.exec(String(url || '')) || [])[1] || '';
const names = (c, self) => {
  const others = (c.participants || []).filter((p) => String(p.id) !== String(self)).map((p) => p.full_name || p.name).filter(Boolean);
  return others.join(', ');
};

/** The Inbox and Sent folders, as the D2L mailbox reader returns them: { inbox: [row], sent: [row], seen }. */
async function readMailbox() {
  const self = await me();
  const read = async (scope) => {
    const r = await all(`/api/v1/conversations?scope=${scope}&per_page=50`, 2);
    if (!Array.isArray(r.data)) throw new Error(`Canvas answered ${r.status} for the ${scope} folder.`);
    return r.data.map((c) => ({ url: abs(`/conversations/${c.id}`), subject: c.subject || '(no subject)', from: names(c, self) || 'You', date: c.last_message_at || c.last_authored_message_at || '', unread: c.workflow_state === 'unread', text: [c.context_name, c.last_message].filter(Boolean).join(' · ').slice(0, 400) }));
  };
  const inbox = await read('inbox');
  let sent = [];
  let sentError = null;
  try {
    sent = await read('sent');
  } catch (err) {
    sentError = String(err.message || err);
  }
  return { inbox, sent, seen: { at: new Date().toISOString(), platform: 'canvas', inbox: inbox.length, sentRows: sent.length, sentError } };
}

const plainText = (html) =>
  String(html || '')
    .replace(/<(br|\/p|\/div|\/li)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();

/**
 * One conversation as text, laid out the way Kea's message cleanup reads a D2L message: From and Subject lines, the
 * newest message, then the earlier ones as quoted text ("On <date>, <name> wrote:"). Reading it doesn't mark it read on
 * Canvas (Kea marks it read in Kea).
 */
async function readMessage(target) {
  const url = typeof target === 'string' ? target : target?.url || '';
  const id = conversationId(url);
  if (!id) throw new Error('This message has no Canvas link to open.');
  const r = await browser.getJson(`/api/v1/conversations/${id}?auto_mark_as_read=false`);
  if (!r.data) throw new Error(`Canvas answered ${r.status} for this message.`);
  const c = r.data;
  const who = new Map((c.participants || []).map((p) => [String(p.id), p.full_name || p.name || '']));
  const when = (at) => (at ? new Date(at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : '');
  const msgs = (c.messages || []).slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const files = (m) => ((m.attachments || []).length ? `\n\nAttached: ${m.attachments.map((x) => `[${x.display_name || x.filename}](${x.url})`).join(', ')}` : '');
  const [first, ...rest] = msgs;
  const text = [
    `From ${first ? who.get(String(first.author_id)) || '' : ''}`,
    `Received ${first ? when(first.created_at) : ''}`,
    `Subject ${c.subject || '(no subject)'}`,
    first ? plainText(first.body) + files(first) : '',
    ...rest.map((m) => `\nOn ${when(m.created_at)}, ${who.get(String(m.author_id)) || 'someone'} wrote:\n${plainText(m.body)}${files(m)}`)
  ].join('\n');
  return { url: abs(`/conversations/${id}`), text: text.slice(0, 20000) };
}

/**
 * Send a message through Canvas's Inbox: a reply to a conversation, or a new message to people in a class (`to`: their
 * names or emails as Canvas shows them, separated by commas). Sent only when Canvas confirms it: { sent: true }.
 */
async function sendMessage({ url = '', ou = '', subject = '', body = '', to = '' }) {
  const text = String(body || '').trim();
  if (!text) throw new Error('Write something first.');
  const id = conversationId(url);
  const showInbox = (why) => browser.show(abs(id ? `/conversations/${id}` : '/conversations')).then(() => ({ sent: false, shown: true, why }));
  if (url && !id) throw new Error('This message has no Canvas link to reply through.');
  if (id) {
    const r = await browser.postForm(`/api/v1/conversations/${id}/add_message`, { body: text });
    return r.status >= 200 && r.status < 300 ? { sent: true, how: 'canvas' } : showInbox(`Canvas didn’t take the reply (it answered ${r.status}). Your message is below in Kea; paste it there.`);
  }
  if (!ou) throw new Error('Pick the class to send it through.');
  const ids = [];
  for (const name of String(to).split(/[,;]+/).map((x) => x.trim()).filter(Boolean)) {
    const r = await browser.getJson(`/api/v1/search/recipients?search=${encodeURIComponent(name)}&context=course_${ou}&type=user&per_page=10`);
    const found = Array.isArray(r.data) ? r.data.filter((x) => x.id && !String(x.id).startsWith('course_')) : [];
    const exact = found.filter((x) => [x.name, x.full_name, x.email, x.login_id].some((v) => v && String(v).toLowerCase() === name.toLowerCase()));
    const pick = exact.length === 1 ? exact[0] : found.length === 1 ? found[0] : null;
    if (!pick) throw new Error(found.length ? `More than one person in this class matches "${name}". Type their full name as Canvas shows it.` : `Kea couldn’t find "${name}" in this class on Canvas. Type their name as Canvas shows it.`);
    ids.push(String(pick.id));
  }
  if (!ids.length) throw new Error('Add who it’s to.');
  const r = await browser.postForm('/api/v1/conversations', { 'recipients[]': ids, subject: String(subject || ''), body: text, context_code: `course_${ou}`, group_conversation: ids.length > 1 ? 'true' : 'false' });
  return r.status >= 200 && r.status < 300 ? { sent: true, how: 'canvas' } : showInbox(`Canvas didn’t take the message (it answered ${r.status}). Your message is below in Kea; paste it there.`);
}

module.exports = { area, enrollments, topicPosts, me, readMailbox, readMessage, sendMessage, kindOf, _test: { folder, quiz, topic, gradeValue, submissionOf } };
