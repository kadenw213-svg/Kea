// Which class notifications the student wants on this computer (Settings → Kea Scholar → Notifications): messages,
// announcements and grades each on or off, classes kept quiet, and quiet hours (shown without a sound). Everything
// still goes to the Inbox and Messages; this only decides what pops up.
const settings = require('../settings.cjs');

/** messages, announcements or grades, from an item's kind. */
const kindOf = (kind) => (/grade|feedback/.test(kind || '') ? 'grades' : /announcement|news/.test(kind || '') ? 'announcements' : 'messages');

function wanted(kind, course) {
  const k = kindOf(kind);
  const key = { messages: 'scholar.notifyMessages', announcements: 'scholar.notifyAnnouncements', grades: 'scholar.notifyGrades' }[k];
  if (settings.get(key, true) === false) return false;
  const quietClasses = String(settings.get('scholar.notifyQuietClasses', '') || '')
    .split(/[,\s]+/)
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
  return !course || !quietClasses.includes(String(course).toUpperCase());
}

/** Inside the quiet hours: notified without a sound. */
function silent() {
  const from = String(settings.get('scholar.notifyQuietFrom', '') || '');
  const to = String(settings.get('scholar.notifyQuietTo', '') || '');
  if (!/^\d{1,2}:\d{2}$/.test(from) || !/^\d{1,2}:\d{2}$/.test(to)) return false;
  const min = (t) => Number(t.split(':')[0]) * 60 + Number(t.split(':')[1]);
  const d = new Date();
  const now = d.getHours() * 60 + d.getMinutes();
  const a = min(from);
  const b = min(to);
  return a <= b ? now >= a && now < b : now >= a || now < b;
}

module.exports = { wanted, silent, kindOf };
