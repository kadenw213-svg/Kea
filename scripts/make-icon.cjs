// Renders build/icon.png (1024px, transparent corners) with Electron. Run: electron scripts/make-icon.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const draw = `(() => {
  const c = document.createElement('canvas'); c.width = c.height = 1024;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(72, 72, 952, 952);
  grad.addColorStop(0, '#a8c7fa'); grad.addColorStop(0.45, '#7cacf8'); grad.addColorStop(1, '#c58af9');
  g.fillStyle = grad; g.beginPath(); g.roundRect(72, 72, 880, 880, 200); g.fill();
  g.translate(252, 252); g.scale(520 / 24, 520 / 24);
  g.strokeStyle = '#0b1d3a'; g.lineWidth = 1.6; g.lineCap = 'round'; g.lineJoin = 'round';
  for (const d of ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6', 'M8 13h8', 'M8 17h5']) g.stroke(new Path2D(d));
  return c.toDataURL('image/png');
})()`;
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('data:text/html,<html></html>');
  const url = await win.webContents.executeJavaScript(draw);
  fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon.png'), Buffer.from(url.split(',')[1], 'base64'));
  app.quit();
});
