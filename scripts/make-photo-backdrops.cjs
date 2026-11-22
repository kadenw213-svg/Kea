// Kea's photo backgrounds (Kea 0.100): five muted nature photographs from Wikimedia Commons (Featured pictures, openly
// licensed), cropped to 2560×1600, their colour softened, saved to public/backdrops/photo-<n>.jpg with credits.json
// (each photo's author, licence and page, shown in Settings → Look & feel → Background). Kea fades slowly from one to
// the next while it's open.
//
//   node_modules\electron\dist\electron.exe scripts\make-photo-backdrops.cjs
//
// The CC BY-SA ones are shared under the same licence as adapted (cropped, colour-softened) versions; credits.json and
// Settings say so.
const { app, BrowserWindow, net } = require('electron');
const fs = require('fs');
const path = require('path');

const W = 2560;
const H = 1600;
// Muted: less colour, a touch less contrast, slightly darker (Kea darkens further on screen with the scrim).
const GRADE = 'saturate(0.68) contrast(0.94) brightness(0.9)';
const PHOTOS = [
  { name: 'Lake Clearwater', place: 'Canterbury, New Zealand', file: 'Lake Clearwater, Canterbury, New Zealand 02.jpg', artist: 'Michal Klajban', license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0', focusY: 0.5 },
  { name: 'Fog over Loch Tay', place: 'Scottish Highlands', file: 'Trees in fog on the northern side of Loch Tay, Scottish Highlands, Scotland.jpg', artist: 'Michal Klajban', license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0', focusY: 0.5 },
  { name: 'Valley in fog', place: 'Vosges, France', file: 'Vallee-brouillard.jpg', artist: 'Thomas Bresson', license: 'CC BY 3.0', licenseUrl: 'https://creativecommons.org/licenses/by/3.0', focusY: 0.55 },
  { name: 'Driftwood at dusk', place: 'Kaikōura, New Zealand', file: 'Driftwood on the beach north of Kaikoura, Canterbury, New Zealand 02.jpg', artist: 'Michal Klajban', license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0', focusY: 0.55 },
  { name: 'Breiðamerkurjökull glacier', place: 'Iceland', file: 'Breiðamerkurjökull glacier, Iceland, 20240719 1514 2687.jpg', artist: 'Jakub Hałun', license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0', focusY: 0.45 }
];
const pageOf = (f) => `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(f.replace(/ /g, '_'))}`;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const dir = path.join(__dirname, '..', 'public', 'backdrops');
  fs.mkdirSync(dir, { recursive: true });
  const win = new BrowserWindow({ width: 400, height: 300, show: false });
  await win.loadURL('about:blank');
  const credits = [];
  for (let i = 0; i < PHOTOS.length; i++) {
    const p = PHOTOS[i];
    const r = await net.fetch(`https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(p.file)}?width=3840`, { headers: { 'user-agent': 'KeaBackdropScript/1.0 (build tooling)' } });
    if (!r.ok) throw new Error(`${p.file}: ${r.status}`);
    const b64 = Buffer.from(await r.arrayBuffer()).toString('base64');
    const url = await win.webContents.executeJavaScript(`(async () => {
      const im = new Image(); im.src = 'data:image/jpeg;base64,${b64}'; await im.decode();
      const c = document.createElement('canvas'); c.width = ${W}; c.height = ${H};
      const g = c.getContext('2d');
      const s = Math.max(${W} / im.width, ${H} / im.height);
      const w = im.width * s, h = im.height * s;
      g.filter = ${JSON.stringify(GRADE)};
      g.drawImage(im, (${W} - w) / 2, (${H} - h) * ${p.focusY}, w, h);
      return c.toDataURL('image/jpeg', 0.8);
    })()`);
    const jpg = Buffer.from(url.split(',')[1], 'base64');
    const out = `photo-${i + 1}.jpg`;
    fs.writeFileSync(path.join(dir, out), jpg);
    credits.push({ file: out, name: p.name, place: p.place, artist: p.artist, license: p.license, licenseUrl: p.licenseUrl, source: pageOf(p.file), changes: 'Cropped and colour-softened for Kea' });
    console.log(out, Math.round(jpg.length / 1024), 'KB');
  }
  fs.writeFileSync(path.join(dir, 'credits.json'), JSON.stringify(credits, null, 2));
  win.destroy();
  app.quit();
});
