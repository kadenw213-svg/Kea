// Audience window for presenting on a second screen while the speaker view stays on this one.
const { app, ipcMain, BrowserWindow, screen, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { appOnly, handleApp } = require('./ipcGuard.cjs');

let audience = null;

// The audience page may show its slides and nothing else: no scripts of its own (Kea's driver below is run by Kea, not
// by the page), no web addresses, no files from this PC, only pictures and fonts already inside it. The policy is put
// first in the page whatever HTML the renderer sends, and the window's own session refuses every other request.
const AUDIENCE_CSP = "default-src 'none'; script-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; media-src data: blob:; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
/** The page's HTML with the policy as the first thing in its <head> (before anything it could load). */
function withCsp(html, csp = AUDIENCE_CSP) {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  const s = String(html);
  if (/<head(\s[^>]*)?>/i.test(s)) return s.replace(/<head(\s[^>]*)?>/i, (m) => `${m}${meta}`);
  if (/<html(\s[^>]*)?>/i.test(s)) return s.replace(/<html(\s[^>]*)?>/i, (m) => `${m}<head>${meta}</head>`);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(s);
  return doctype ? `${doctype[0]}<head>${meta}</head>${s.slice(doctype[0].length)}` : `<head>${meta}</head>${s}`;
}
const pageKey = (u) => {
  try {
    return decodeURIComponent(u).toLowerCase();
  } catch {
    return String(u).toLowerCase();
  }
};
let audienceSession = null;
const audiencePages = new Set();
function audienceSessionGet() {
  if (audienceSession) return audienceSession;
  audienceSession = session.fromPartition('kea-audience');
  audienceSession.webRequest.onBeforeRequest((details, callback) => {
    const u = details.url;
    callback({ cancel: !(audiencePages.has(pageKey(u)) || u.startsWith('data:') || u.startsWith('blob:')) });
  });
  audienceSession.setPermissionRequestHandler((_wc, _p, callback) => callback(false));
  audienceSession.setPermissionCheckHandler(() => false);
  return audienceSession;
}

// Runs inside the audience page (which itself allows no scripts): fits the stage and switches slides.
const DRIVER = `(() => {
  const st = document.getElementById('stage');
  const W = st.offsetWidth, H = st.offsetHeight;
  const fit = () => { const s = Math.min(innerWidth / W, innerHeight / H); st.style.transform = 'scale(' + s + ') translate(-50%, -50%)'; };
  addEventListener('resize', fit); fit();
  let cur = -1;
  window.go = (i, type, dur, dir) => {
    const els = document.querySelectorAll('.sl'); const prev = els[cur]; const next = els[i];
    if (!next) return;
    els.forEach((e) => (e.className = 'sl'));
    if (prev && prev !== next && type !== 'none') { prev.className = 'sl on tr-out tr-' + type + (dir < 0 ? ' back' : ''); prev.style.animationDuration = dur + 's'; }
    next.className = 'sl on' + (type !== 'none' && prev ? ' tr-in tr-' + type + (dir < 0 ? ' back' : '') : '');
    next.style.animationDuration = dur + 's';
    cur = i;
  };
})()`;

function register({ log, getWindow }) {
  handleApp(ipcMain, 'present:screens', () => screen.getAllDisplays().length);

  ipcMain.handle('present:open', appOnly(async (_e, html, start) => {
    try {
      if (audience && !audience.isDestroyed()) audience.close();
      const main = getWindow();
      const here = main ? screen.getDisplayMatching(main.getBounds()) : screen.getPrimaryDisplay();
      const other = screen.getAllDisplays().find((d) => d.id !== here.id);
      if (!other) return false;
      const file = path.join(app.getPath('temp'), `kea-audience-${Date.now()}.html`);
      fs.writeFileSync(file, withCsp(html));
      const url = require('url').pathToFileURL(file).href;
      audiencePages.add(pageKey(url));
      audience = new BrowserWindow({
        x: other.bounds.x,
        y: other.bounds.y,
        width: other.bounds.width,
        height: other.bounds.height,
        frame: false,
        backgroundColor: '#000000',
        show: false,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, session: audienceSessionGet() }
      });
      audience.setMenu(null);
      // Nothing in the audience window may navigate or open other pages.
      audience.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      audience.webContents.on('will-navigate', (ev) => ev.preventDefault());
      try {
        await audience.loadFile(file);
      } finally {
        audiencePages.delete(pageKey(url));
        fs.rm(file, { force: true }, () => {});
      }
      audience.setFullScreen(true);
      audience.show();
      await audience.webContents.executeJavaScript(DRIVER);
      await audience.webContents.executeJavaScript(`go(${Number(start) || 0}, 'none', 0, 1)`);
      audience.on('closed', () => {
        audience = null;
        getWindow()?.webContents.send('present:closed');
      });
      main?.focus();
      return true;
    } catch (err) {
      log('audience window failed', err);
      return false;
    }
  }));

  handleApp(ipcMain, 'present:goto', (_e, i, type, dur, dir) => {
    if (!audience || audience.isDestroyed()) return false;
    const safeType = ['none', 'fade', 'push', 'wipe', 'zoom', 'cover'].includes(type) ? type : 'none';
    audience.webContents.executeJavaScript(`go(${Number(i) || 0}, '${safeType}', ${Number(dur) || 0}, ${Number(dir) < 0 ? -1 : 1})`).catch(() => {});
    return true;
  });

  handleApp(ipcMain, 'present:close', () => {
    if (audience && !audience.isDestroyed()) audience.close();
    audience = null;
    return true;
  });
}

module.exports = { register, withCsp, AUDIENCE_CSP };
