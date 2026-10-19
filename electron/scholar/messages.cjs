// Class-site messages in Kea, like email: read a message in full, write a reply or a new message here, and Kea sends it
// through the class site (browser.sendMessage presses the site's own Reply and Send). The messages come from the class
// site's whole mailbox (its Inbox and Sent folders, read every 15 minutes by the primary) and its alerts; drafts, what
// was sent from Kea and the bodies read are kept in the profile's messages.json.
//   messages.json  { drafts: { [key]: { course, to, subject, body, replyTo, at } }, sent: [{ id, at, course, to,
//                    subject, body, replyTo, confirmed, why }], bodies: { [id]: { text, at } },
//                    box: { at, inbox: [msg], sent: [msg], seeded }, seen }   msg = { id, url, subject, from, date,
//                    unread, course, first }
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ipcMain, BrowserWindow } = require('electron');
const profiles = require('./profiles.cjs');

const file = () => path.join(profiles.paths().dir, 'messages.json');
function read() {
  try {
    const m = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return { drafts: m.drafts || {}, sent: m.sent || [], bodies: m.bodies || {}, box: m.box || { inbox: [], sent: [] }, seen: m.seen || null };
  } catch {
    return { drafts: {}, sent: [], bodies: {}, box: { inbox: [], sent: [] }, seen: null };
  }
}
function write(m) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const tmp = `${file()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(m, null, 1));
  fs.renameSync(tmp, file());
}
const changed = () => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('scholar:changed'));

let deps = null;
let syncing = null;
let lastSync = 0;
const notes = [];
const mailId = (r) => `mail:${crypto.createHash('sha1').update(r.url || `${r.subject}|${r.from}|${r.date}`).digest('hex').slice(0, 16)}`;

/**
 * Read the class site's mailbox (Inbox and Sent) into Kea, at most every 15 minutes unless `force`. New unread
 * messages are notified (clicking one opens it in Kea's Messages). Returns { inbox, sent } counts, or null when skipped.
 */
async function syncMailbox(force = false) {
  if (!deps) return null;
  if (syncing) return syncing;
  if (!force && Date.now() - lastSync < 15 * 60e3) return null;
  lastSync = Date.now();
  syncing = (async () => {
    const { browser, db } = deps;
    if (!(await browser.status()).signedIn) return null;
    const box = await browser.readMailbox();
    // Which class a message is about: its code in the subject or text, or its sender teaching the class.
    const classes = await db.courses(profiles.paths().db, profiles.paths().textbooks, {}).catch(() => []);
    const courseOf = (r) => {
      const hay = `${r.subject} ${r.text} ${r.from}`;
      const byCode = classes.find((c) => c.code && new RegExp(`\\b${c.code.replace(/(\D+)(\d+)/, '$1\\s*$2')}`, 'i').test(hay));
      if (byCode) return byCode.code;
      // (The surname: the last plain word, so "Kristin R. Rowan, Ph.D." is Rowan.)
      const last = (n) => String(n || '').replace(/,.*$/, '').split(/[^A-Za-z'-]+/).filter((w) => w.length > 2).pop() || '';
      const byTeacher = classes.find((c) => c.instructor && last(c.instructor) && new RegExp(`\\b${last(c.instructor)}\\b`, 'i').test(r.from || ''));
      return byTeacher?.code || '';
    };
    const m = read();
    const before = new Map((m.box.inbox || []).map((x) => [x.id, x]));
    const shape = (rows, folder) =>
      rows.map((r) => {
        const id = mailId(r);
        const old = (folder === 'inbox' ? before : new Map((m.box.sent || []).map((x) => [x.id, x]))).get(id);
        return { id, folder, url: r.url, subject: r.subject, from: r.from, date: r.date, unread: !!r.unread, course: courseOf(r) || old?.course || '', first: old?.first || new Date().toISOString(), preview: r.text };
      });
    const inbox = shape(box.inbox, 'inbox');
    const sent = shape(box.sent, 'sent');
    // An empty read when messages were there before is a page Kea couldn't read, not an empty mailbox: keep the old.
    const keepOld = !inbox.length && before.size > 0;
    const fresh = read();
    // (Messages that scrolled off the class site's first page are kept: the mailbox in Kea only grows.)
    const merged = (now, old) => [...now, ...(old || []).filter((o) => !now.some((x) => x.id === o.id))].slice(0, 1000);
    fresh.box = {
      at: new Date().toISOString(),
      inbox: keepOld ? fresh.box.inbox : merged(inbox, fresh.box.inbox),
      sent: merged(sent, fresh.box.sent),
      seeded: true
    };
    fresh.seen = box.seen;
    write(fresh);
    changed();
    // New unread mail since the last read (not on the very first read, which would notify the whole mailbox).
    if (m.box.seeded && !keepOld) {
      const { Notification } = require('electron');
      for (const n of inbox.filter((x) => x.unread && !before.has(x.id)).slice(0, 5)) {
        if (!Notification.isSupported()) continue;
        const note = new Notification({ title: `${n.course ? `${n.course}: ` : ''}${n.from || 'New message'}`, body: `${n.subject}${n.preview ? `\n${n.preview.slice(0, 160)}` : ''}` });
        note.on('click', () => openInKea(n.id));
        note.show();
        notes.push(note);
        notes.splice(0, Math.max(0, notes.length - 20));
      }
    }
    // The newest messages' text, read ahead (a few each time), so they open at once.
    const fetched = read();
    for (const x of inbox.filter((i) => !fetched.bodies[i.id]).slice(0, 4)) {
      try {
        const page = await browser.readMessage(x.url ? x.url : { loc: { folder: 'inbox', subject: x.subject, date: x.date } });
        const now = read();
        now.bodies[x.id] = { text: page.text, at: new Date().toISOString() };
        write(now);
      } catch {}
    }
    if (inbox.length) changed();
    return { inbox: inbox.length, sent: sent.length, unreadable: keepOld };
  })().finally(() => {
    syncing = null;
  });
  return syncing;
}

/** Bring Kea forward on its Messages page, with this message open. */
function openInKea(id) {
  const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && /index\.html|localhost/.test(x.webContents.getURL()));
  if (!w) return;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
  w.webContents.send('scholar:openMail', id);
}

function register({ browser, precheck, db }) {
  deps = { browser, precheck, db };
  // Every message Kea knows: the class site's mailbox, and alerts for any the mailbox read hasn't caught yet.
  const inboxMessages = () => {
    const box = read().box.inbox || [];
    const urls = new Set(box.map((x) => x.url).filter(Boolean));
    const alerts = precheck
      .readInbox()
      .items.filter((i) => i.kind === 'message' && !(i.url && urls.has(i.url)))
      .map((i) => ({ id: i.id, course: i.course || '', title: i.title, from: '', preview: i.body || '', at: i.at, url: i.url || '', read: !!i.read }));
    // (A mailbox message without a link of its own is opened by clicking it in its folder: its `loc`.)
    return [...box.map((x) => ({ id: x.id, course: x.course, title: x.subject, from: x.from, preview: x.preview || '', at: x.date || x.first, sortAt: x.first, url: x.url, loc: { folder: x.folder || 'inbox', subject: x.subject, date: x.date }, read: !x.unread })), ...alerts];
  };

  ipcMain.handle('scholar:mailList', () => {
    const m = read();
    // Sent: what Kea sent, then the class site's Sent folder (messages sent there directly, or before Kea).
    const mine = m.sent.slice(0, 200);
    const siteSent = (m.box.sent || [])
      .filter((x) => !mine.some((s) => s.confirmed && s.subject && x.subject && s.subject.toLowerCase().includes(x.subject.toLowerCase().replace(/^re:\s*/, ''))))
      .map((x) => ({ id: x.id, at: x.date || x.first, course: x.course, to: x.from, subject: x.subject, body: m.bodies[x.id]?.text || x.preview || '', replyTo: null, confirmed: true, why: null, url: x.url, fromSite: true }));
    return {
      messages: inboxMessages().map((i) => ({ id: i.id, course: i.course || '', title: i.title, from: i.from || '', preview: i.preview || '', at: i.at, url: i.url || '', canOpen: !!(i.url || i.loc), read: !!i.read, full: m.bodies[i.id]?.text || null })),
      sent: [...mine, ...siteSent],
      drafts: Object.entries(m.drafts).map(([key, d]) => ({ key, ...d })),
      checked: m.box.at || null
    };
  });

  // Read the class site's mailbox now (the Refresh button).
  ipcMain.handle('scholar:mailSync', () => syncMailbox(true));
  // A message opened in Kea counts as read here (the class site marks it read when Kea opens it to read the body).
  const markRead = (id) => {
    const m = read();
    const x = (m.box.inbox || []).find((i) => i.id === id);
    if (x && x.unread) {
      x.unread = false;
      write(m);
    }
  };

  // The whole message, read from the class site (and kept, so it opens at once next time).
  ipcMain.handle('scholar:mailRead', async (_e, id, refresh) => {
    const m = read();
    if (!refresh && m.bodies[id]) return m.bodies[id];
    const box = inboxMessages().find((i) => i.id === id);
    const sentItem = (read().box.sent || []).find((x) => x.id === id);
    const item = box || (sentItem && { ...sentItem, loc: { folder: 'sent', subject: sentItem.subject, date: sentItem.date } });
    if (!item?.url && !item?.loc) return { text: item?.preview || '', at: null, noLink: true };
    const page = await browser.readMessage(item.url ? item.url : { loc: item.loc });
    markRead(id);
    const fresh = read();
    fresh.bodies[id] = { text: page.text, at: new Date().toISOString() };
    // (Only the newest 300 are kept.)
    const keys = Object.keys(fresh.bodies);
    for (const k of keys.slice(0, Math.max(0, keys.length - 300))) delete fresh.bodies[k];
    write(fresh);
    return fresh.bodies[id];
  });

  ipcMain.handle('scholar:mailDraft', (_e, key, draft) => {
    const m = read();
    const k = String(key || '').slice(0, 120);
    if (!k) return false;
    if (draft && String(draft.body || '').trim()) m.drafts[k] = { course: String(draft.course || ''), to: String(draft.to || '').slice(0, 500), subject: String(draft.subject || '').slice(0, 300), body: String(draft.body).slice(0, 20000), replyTo: draft.replyTo || null, at: new Date().toISOString() };
    else delete m.drafts[k];
    write(m);
    return true;
  });

  // Send: only when the student presses Send in Kea. One at a time, never retried by itself (a retry could send twice).
  let sending = false;
  ipcMain.handle('scholar:mailSend', async (_e, msg) => {
    if (sending) throw new Error('A message is already being sent. Wait for it to finish.');
    const body = String(msg?.body || '').trim();
    if (!body) throw new Error('Write something first.');
    const reply = msg.replyTo ? inboxMessages().find((i) => i.id === msg.replyTo) : null;
    if (msg.replyTo && !reply?.url && !reply?.loc) throw new Error('That message has no class-site link to reply through. Open it on the class site instead.');
    const course = String(msg.course || reply?.course || '');
    const ou = course ? (await db.watchList(profiles.paths().db)).find((c) => c.code === course)?.ou || '' : '';
    if (!reply && !ou) throw new Error('Pick the class to send it through.');
    if (!reply && !/@|\w/.test(String(msg.to || ''))) throw new Error('Add who it’s to.');
    sending = true;
    try {
      const r = await browser.sendMessage({ url: reply?.url || '', loc: reply && !reply.url ? reply.loc : null, ou, subject: String(msg.subject || ''), body, to: String(msg.to || '') });
      const m = read();
      m.sent.unshift({ id: `${Date.now()}`, at: new Date().toISOString(), course, to: String(msg.to || ''), subject: String(msg.subject || reply?.title || ''), body, replyTo: msg.replyTo || null, confirmed: !!r.sent, why: r.why || null });
      m.sent = m.sent.slice(0, 500);
      // A sent message's draft goes; one Kea couldn't confirm stays until the student says it went.
      if (r.sent && msg.draftKey) delete m.drafts[msg.draftKey];
      write(m);
      changed();
      return r;
    } finally {
      sending = false;
    }
  });
}

module.exports = { register, syncMailbox };
