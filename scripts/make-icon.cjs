// Renders build/icon.png (1024px, transparent margin) from build/logo.svg with Electron.
// Run: npx electron scripts/make-icon.cjs [out.png]   (the app's in-window logo uses the same SVG)
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const svg = fs.readFileSync(path.join(__dirname, '..', 'build', 'logo.svg'), 'utf8');
const out = process.argv.find((a) => a.endsWith('.png')) || path.join(__dirname, '..', 'build', 'icon.png');
const draw = `(async () => {
  const img = new Image();
  img.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(svg).toString('base64'))};
  await img.decode();
  const c = document.createElement('canvas'); c.width = c.height = 1024;
  c.getContext('2d').drawImage(img, 72, 72, 880, 880);
  return c.toDataURL('image/png');
})()`;
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('data:text/html,<html></html>');
  const url = await win.webContents.executeJavaScript(draw);
  fs.writeFileSync(out, Buffer.from(url.split(',')[1], 'base64'));
  app.quit();
});
