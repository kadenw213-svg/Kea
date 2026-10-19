// Class-site messages in Kea, like email: read a message in full, write a reply or a new message here, and Kea sends it
// through the class site (browser.sendMessage presses the site's own Reply and Send). Drafts and a record of what was
// sent are kept in the profile's messages.json; the messages themselves come from the class site's alerts (the Inbox).
//   messages.json  { drafts: { [key]: { course, to, subject, body, replyTo, at } }, sent: [{ id, at, course, to,
//                    subject, body, replyTo, confirmed, why }], bodies: { [inboxId]: { text, at } } }
const fs = require('fs');
const path = require('path');
const { ipcMain, BrowserWindow } = require('electron');
const profiles = require('./profiles.cjs');

const file = () => path.join(profiles.paths().dir, 'messages.json');
function read() {
  try {
    const m = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return { drafts: m.drafts || {}, sent: m.sent || [], bodies: m.bodies || {} };
  } catch {
    return { drafts: {}, sent: [], bodies: {} };
  }
}
function write(m) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const tmp = `${file()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(m, null, 1));
  fs.renameSync(tmp, file());
}
const changed = () => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('scholar:changed'));

function register({ browser, precheck, db }) {
  const inboxMessages = () => precheck.readInbox().items.filter((i) => i.kind === 'message');

  ipcMain.handle('scholar:mailList', () => {
    const m = read();
    return {
      messages: inboxMessages().map((i) => ({ id: i.id, course: i.course || '', title: i.title, preview: i.body || '', at: i.at, url: i.url || '', read: !!i.read, full: m.bodies[i.id]?.text || null })),
      sent: m.sent.slice(0, 200),
      drafts: Object.entries(m.drafts).map(([key, d]) => ({ key, ...d }))
    };
  });

  // The whole message, read from the class site (and kept, so it opens at once next time).
  ipcMain.handle('scholar:mailRead', async (_e, id, refresh) => {
    const m = read();
    if (!refresh && m.bodies[id]) return m.bodies[id];
    const item = inboxMessages().find((i) => i.id === id);
    if (!item?.url) return { text: item?.body || '', at: null, noLink: true };
    const page = await browser.readMessage(item.url);
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
    if (msg.replyTo && !reply?.url) throw new Error('That message has no class-site link to reply through. Open it on the class site instead.');
    const course = String(msg.course || reply?.course || '');
    const ou = course ? (await db.watchList(profiles.paths().db)).find((c) => c.code === course)?.ou || '' : '';
    if (!reply && !ou) throw new Error('Pick the class to send it through.');
    if (!reply && !/@|\w/.test(String(msg.to || ''))) throw new Error('Add who it’s to.');
    sending = true;
    try {
      const r = await browser.sendMessage({ url: reply?.url || '', ou, subject: String(msg.subject || ''), body, to: String(msg.to || '') });
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

module.exports = { register };
