// Audience window for presenting on a second screen while the speaker view stays on this one.
const { app, ipcMain, BrowserWindow, screen } = require('electron');
const path = require('path');
const fs = require('fs');

let audience = null;

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
  ipcMain.handle('present:screens', () => screen.getAllDisplays().length);

  ipcMain.handle('present:open', async (_e, html, start) => {
    try {
      if (audience && !audience.isDestroyed()) audience.close();
      const main = getWindow();
      const here = main ? screen.getDisplayMatching(main.getBounds()) : screen.getPrimaryDisplay();
      const other = screen.getAllDisplays().find((d) => d.id !== here.id);
      if (!other) return false;
      const file = path.join(app.getPath('temp'), `slate-audience-${Date.now()}.html`);
      fs.writeFileSync(file, html);
      audience = new BrowserWindow({
        x: other.bounds.x,
        y: other.bounds.y,
        width: other.bounds.width,
        height: other.bounds.height,
        frame: false,
        backgroundColor: '#000000',
        show: false,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
      });
      audience.setMenu(null);
      // Nothing in the audience window may navigate or open other pages.
      audience.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      audience.webContents.on('will-navigate', (ev) => ev.preventDefault());
      await audience.loadFile(file);
      fs.rm(file, { force: true }, () => {});
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
  });

  ipcMain.handle('present:goto', (_e, i, type, dur, dir) => {
    if (!audience || audience.isDestroyed()) return false;
    const safeType = ['none', 'fade', 'push', 'wipe', 'zoom', 'cover'].includes(type) ? type : 'none';
    audience.webContents.executeJavaScript(`go(${Number(i) || 0}, '${safeType}', ${Number(dur) || 0}, ${Number(dir) < 0 ? -1 : 1})`).catch(() => {});
    return true;
  });

  ipcMain.handle('present:close', () => {
    if (audience && !audience.isDestroyed()) audience.close();
    audience = null;
    return true;
  });
}

module.exports = { register };
