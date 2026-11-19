// Kea's sidebar can work in the other windows Kea opens (the school library, the class site): read the page the student is
// looking at and answer from it, and, only with the student's yes each time, click a button or fill in a box. Reading is
// what the student asked for; every action shows a question first, naming exactly what Claude wants to do and where.
// The sidebar's tools (window_read, window_click, window_type: src/lib/editorTools.ts) call these.
const { ipcMain, dialog, BrowserWindow } = require('electron');
const { handleApp } = require('./ipcGuard.cjs');

/** Windows the sidebar may work in: [{ win, label }], the last one the student used last. */
const tracked = [];
function track(win, label) {
  if (!win || win.isDestroyed() || tracked.some((t) => t.win === win)) return;
  tracked.push({ win, label });
  const bump = () => {
    const i = tracked.findIndex((t) => t.win === win);
    if (i >= 0) tracked.push(...tracked.splice(i, 1));
  };
  win.on('focus', bump);
  win.on('closed', () => {
    const i = tracked.findIndex((t) => t.win === win);
    if (i >= 0) tracked.splice(i, 1);
  });
}
/** The window to work in: the one used last that is still open and showing. */
function target() {
  for (let i = tracked.length - 1; i >= 0; i--) if (!tracked[i].win.isDestroyed() && tracked[i].win.isVisible()) return tracked[i];
  return null;
}

const NONE = 'No Kea window is open to work in. Ask the student to open the school library (the Library button on the assignment bar) or a class-site page first.';

// Runs in the page. Matching is by what a person sees: visible text, aria-label, title, placeholder or name.
const PAGE = {
  read: `(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const name = (e) => (e.getAttribute('aria-label') || e.innerText || e.value || e.title || e.placeholder || e.name || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    const controls = [...document.querySelectorAll('a[href],button,input,select,textarea,[role=button]')].filter(vis).slice(0, 150)
      .map((e) => ({ kind: e.tagName.toLowerCase() + (e.type && e.tagName === 'INPUT' ? ':' + e.type : ''), name: name(e) })).filter((c) => c.name);
    return { title: document.title, url: location.href, text: (document.body.innerText || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 40000), controls };
  })()`,
  click: (text) => `(() => {
    const want = ${JSON.stringify(String(text).toLowerCase())};
    const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const name = (e) => (e.getAttribute('aria-label') || e.innerText || e.value || e.title || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const all = [...document.querySelectorAll('a[href],button,input[type=button],input[type=submit],[role=button],summary')].filter(vis);
    const el = all.find((e) => name(e) === want) || all.find((e) => name(e).includes(want));
    if (!el) return { ok: false };
    el.scrollIntoView({ block: 'center' }); el.click();
    return { ok: true, name: name(el) };
  })()`,
  type: (label, value) => `(() => {
    const want = ${JSON.stringify(String(label).toLowerCase())};
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const labels = (e) => [e.getAttribute('aria-label'), e.placeholder, e.name, e.id, e.title, (e.labels && e.labels[0] && e.labels[0].innerText)].filter(Boolean).map((s) => s.replace(/\\s+/g, ' ').trim().toLowerCase());
    const all = [...document.querySelectorAll('input:not([type=hidden]):not([type=password]):not([type=file]),textarea')].filter(vis);
    const el = all.find((e) => labels(e).includes(want)) || all.find((e) => labels(e).some((l) => l.includes(want)));
    if (!el) return { ok: false };
    el.focus();
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(value))});
    el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, name: labels(el)[0] || 'a box' };
  })()`
};

/** The student's yes to one action, naming what and where. */
async function approve(t, what) {
  const r = await dialog.showMessageBox(t.win, {
    type: 'question',
    buttons: ['Allow', 'Don’t'],
    defaultId: 1,
    cancelId: 1,
    title: 'Claude wants to act in this window',
    message: `Claude wants to ${what}`,
    detail: `In: ${t.win.webContents.getTitle() || t.label}\n${t.win.webContents.getURL()}`,
    noLink: true
  });
  return r.response === 0;
}

function register() {
  handleApp(ipcMain, 'window:read', async () => {
    const t = target();
    if (!t) return { error: NONE };
    try {
      const page = await t.win.webContents.executeJavaScript(PAGE.read, true);
      return { label: t.label, ...page };
    } catch {
      return { error: 'Kea couldn’t read that page. Ask the student to wait for it to finish loading.' };
    }
  });
  handleApp(ipcMain, 'window:click', async (_e, text) => {
    const t = target();
    if (!t) return { error: NONE };
    const what = String(text || '').trim().slice(0, 80);
    if (!what) return { error: 'Say what to click.' };
    if (!(await approve(t, `click “${what}”`))) return { error: 'The student said no. Don’t try that again; ask what they would like instead.' };
    const r = await t.win.webContents.executeJavaScript(PAGE.click(what), true).catch(() => ({ ok: false }));
    return r.ok ? { ok: true, clicked: r.name } : { error: `Nothing on the page is called “${what}”. Read the page again to see its buttons and links.` };
  });
  handleApp(ipcMain, 'window:type', async (_e, label, value) => {
    const t = target();
    if (!t) return { error: NONE };
    const where = String(label || '').trim().slice(0, 80);
    const text = String(value ?? '').slice(0, 2000);
    if (!where) return { error: 'Say which box to fill in.' };
    if (!(await approve(t, `type “${text.length > 60 ? text.slice(0, 60) + '…' : text}” into “${where}”`))) return { error: 'The student said no. Don’t try that again; ask what they would like instead.' };
    const r = await t.win.webContents.executeJavaScript(PAGE.type(where, text), true).catch(() => ({ ok: false }));
    return r.ok ? { ok: true, filledIn: r.name } : { error: `No box on the page is called “${where}”. Read the page again to see its boxes. (Password and file boxes are never filled in.)` };
  });
}

module.exports = { register, track, target, _test: { PAGE } };
