// Kea's default background, "Snowy ridge": a calm, dark, snowy mountain scene drawn in code (seeded, so it comes out
// the same every time), rendered by Electron to JPEGs in public/backdrops/ (a dark one, and a light one for light themes).
//
//   node_modules\electron\dist\electron.exe scripts\make-backdrop.cjs
//
// The scene: a night sky (a faint teal glow low on the horizon, a few dim stars, a soft moon), five ridges that get
// lighter and bluer with distance, snow on the upper slopes lit from the left, mist between the ridges, and a dark
// line of pines in front. Kept under about a quarter brightness so Kea's dark look stays dark over it.
const path = require('path');
const fs = require('fs');

const W = 2560;
const H = 1600;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A ridge line by midpoint displacement: n+1 points across the width around `base`, `rough` the starting spread. */
function ridge(r, base, rough, peaks, n = 256) {
  const ys = new Array(n + 1).fill(0);
  ys[0] = base + (r() - 0.5) * rough;
  ys[n] = base + (r() - 0.5) * rough;
  const go = (a, b, spread) => {
    if (b - a < 2) return;
    const m = (a + b) >> 1;
    ys[m] = (ys[a] + ys[b]) / 2 + (r() - 0.5) * spread;
    go(a, m, spread * 0.6);
    go(m, b, spread * 0.6);
  };
  go(0, n, rough);
  // A few broad peaks, so the skyline has shape rather than noise.
  for (const p of peaks) {
    for (let i = 0; i <= n; i++) {
      const d = (i / n - p.x) / p.w;
      ys[i] -= p.h * Math.exp(-Math.pow(Math.abs(d), 1.15) * 1.6);
    }
  }
  return ys.map((y, i) => [(i / n) * W, y]);
}

const mix = (a, b, t) => {
  const pa = a.match(/\w\w/g).map((h) => parseInt(h, 16));
  const pb = b.match(/\w\w/g).map((h) => parseInt(h, 16));
  return pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, '0')).join('');
};

function scene(theme) {
  const dark = theme === 'dark';
  const r = rng(dark ? 20261121 : 20261121);
  const P = dark
    ? { skyTop: '070a10', skyMid: '0c121c', skyLow: '172130', glow: '4f8f96', far: '1f2836', near: '06080b', snowLit: '8797a9', snowShade: '465467', haze: '131b26', mist: '8ea3b8', trees: '040609', moon: 'cfd8e2' }
    : { skyTop: 'aebccb', skyMid: 'c9d3dd', skyLow: 'e2e7ec', glow: 'f3e6d0', far: '9fb0c2', near: '8593a2', snowLit: 'f7f9fb', snowShade: 'c3ced9', haze: 'd5dde5', mist: 'ffffff', trees: '9aa6b3', moon: 'ffffff' };
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
  out.push(`<defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#${P.skyTop}"/><stop offset="0.55" stop-color="#${P.skyMid}"/><stop offset="1" stop-color="#${P.skyLow}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#${P.glow}" stop-opacity="${dark ? 0.16 : 0.5}"/><stop offset="1" stop-color="#${P.glow}" stop-opacity="0"/></radialGradient>
    <radialGradient id="moonglow" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#${P.moon}" stop-opacity="${dark ? 0.12 : 0.35}"/><stop offset="1" stop-color="#${P.moon}" stop-opacity="0"/></radialGradient>
    <linearGradient id="mist" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#${P.mist}" stop-opacity="0"/><stop offset="0.6" stop-color="#${P.mist}" stop-opacity="${dark ? 0.07 : 0.35}"/><stop offset="1" stop-color="#${P.mist}" stop-opacity="0"/></linearGradient>
    <radialGradient id="vig" cx="0.5" cy="0.45" r="0.75"><stop offset="0.55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="${dark ? 0.55 : 0.12}"/></radialGradient>
    <filter id="soft" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="28"/></filter>
    <filter id="soft2" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="6"/></filter>
  </defs>`);
  out.push(`<rect width="${W}" height="${H}" fill="url(#sky)"/>`);
  // The glow low on the horizon (the "lively" part), and a faint aurora ribbon.
  out.push(`<ellipse cx="${W * 0.38}" cy="${H * 0.56}" rx="${W * 0.55}" ry="${H * 0.22}" fill="url(#glow)"/>`);
  if (dark) {
    let d = `M ${-100} ${H * 0.3}`;
    for (let x = -100; x <= W + 100; x += 80) d += ` L ${x} ${H * 0.27 + Math.sin(x / 260) * 40 + Math.sin(x / 97) * 12}`;
    out.push(`<path d="${d}" fill="none" stroke="#5fa79f" stroke-opacity="0.07" stroke-width="90" filter="url(#soft)"/>`);
    out.push(`<path d="${d}" fill="none" stroke="#7a78b8" stroke-opacity="0.04" stroke-width="40" transform="translate(0 -60)" filter="url(#soft)"/>`);
    // Stars: dim, more of them higher up.
    for (let i = 0; i < 260; i++) {
      const y = Math.pow(r(), 1.6) * H * 0.55;
      const x = r() * W;
      const big = r() < 0.06;
      out.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${big ? 1.6 : 0.6 + r() * 0.7}" fill="#dfe8f2" fill-opacity="${(big ? 0.55 : 0.12 + r() * 0.3).toFixed(2)}"/>`);
    }
  }
  // The moon (dark) or a pale sun haze (light), upper right.
  out.push(`<circle cx="${W * 0.78}" cy="${H * 0.16}" r="220" fill="url(#moonglow)"/>`);
  if (dark) out.push(`<circle cx="${W * 0.78}" cy="${H * 0.16}" r="26" fill="#${P.moon}" fill-opacity="0.42"/>`);

  // Five ridges, far to near.
  const layers = [
    { base: H * 0.53, rough: 220, peaks: [{ x: 0.05, w: 0.08, h: 120 }, { x: 0.22, w: 0.08, h: 260 }, { x: 0.36, w: 0.07, h: 140 }, { x: 0.58, w: 0.1, h: 200 }, { x: 0.71, w: 0.06, h: 120 }, { x: 0.86, w: 0.07, h: 160 }, { x: 0.98, w: 0.06, h: 110 }], t: 0, snow: 0.95 },
    { base: H * 0.61, rough: 210, peaks: [{ x: 0.08, w: 0.07, h: 130 }, { x: 0.25, w: 0.07, h: 100 }, { x: 0.4, w: 0.09, h: 230 }, { x: 0.55, w: 0.06, h: 110 }, { x: 0.72, w: 0.06, h: 170 }, { x: 0.9, w: 0.08, h: 120 }], t: 0.3, snow: 0.85 },
    { base: H * 0.67, rough: 150, peaks: [{ x: 0.15, w: 0.1, h: 180 }, { x: 0.62, w: 0.1, h: 150 }, { x: 0.93, w: 0.06, h: 110 }], t: 0.55, snow: 0.6 },
    { base: H * 0.77, rough: 110, peaks: [{ x: 0.3, w: 0.14, h: 110 }, { x: 0.82, w: 0.12, h: 90 }], t: 0.78, snow: 0 },
    { base: H * 0.88, rough: 60, peaks: [{ x: 0.55, w: 0.2, h: 50 }], t: 1, snow: 0 },
  ];
  layers.forEach((L, li) => {
    const pts = ridge(r, L.base, L.rough, L.peaks);
    const body = mix(P.far, P.near, L.t);
    let d = `M 0 ${H} L ${pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L ')} L ${W} ${H} Z`;
    out.push(`<path d="${d}" fill="#${body}"/>`);
    // Snow: a band under the ridge line, deeper where the ridge is high, faceted by slope (lit from the left).
    if (L.snow > 0) {
      const top = Math.min(...pts.map((p) => p[1]));
      const line = top + (L.base - top) * 0.75;
      const haze = 1 - L.snow;
      // (The snow's lower edge: smooth noise, so it reads as drifts rather than a torn strip.)
      const edge = pts.map(() => (r() - 0.5) * 30);
      for (let pass = 0; pass < 3; pass++) for (let i = 1; i < edge.length - 1; i++) edge[i] = (edge[i - 1] + edge[i] * 2 + edge[i + 1]) / 4;
      const depth = (i) => Math.max(0, (line - pts[i][1]) * 0.36 + edge[i] * 0.7);
      // (Lit or shaded by the slope over a few points, so faces are broad, not striped.)
      const slope = (i) => pts[Math.min(pts.length - 1, i + 4)][1] - pts[Math.max(0, i - 4)][1];
      for (let i = 0; i < pts.length - 1; i++) {
        const [x1, y1] = pts[i];
        const [x2, y2] = pts[i + 1];
        const d1 = depth(i);
        const d2 = depth(i + 1);
        if (d1 <= 0 && d2 <= 0) continue;
        // (Rising to the right faces the light on the left; flat stretches are in between, so there are no hard flips.)
        const light = Math.max(0, Math.min(1, 0.5 - slope(i) / 60));
        const c = mix(mix(P.snowShade, P.snowLit, light), body, Math.min(0.85, haze * 0.8 + (dark ? 0.25 : 0.05)));
        out.push(`<path d="M ${x1.toFixed(1)} ${y1.toFixed(1)} L ${x2.toFixed(1)} ${y2.toFixed(1)} L ${x2.toFixed(1)} ${(y2 + d2).toFixed(1)} L ${x1.toFixed(1)} ${(y1 + d1).toFixed(1)} Z" fill="#${c}" stroke="#${c}" stroke-width="0.6"/>`);
      }
      // Rock showing through the snow: dark streaks down the slopes.
      for (let k = 0; k < 14; k++) {
        const i = Math.floor(r() * (pts.length - 1));
        const [x, y] = pts[i];
        if (y > line) continue;
        const len = (line - y) * (0.15 + r() * 0.25);
        out.push(`<path d="M ${x.toFixed(1)} ${(y + 6).toFixed(1)} l ${((r() - 0.5) * 20).toFixed(1)} ${len.toFixed(1)}" stroke="#${body}" stroke-opacity="0.35" stroke-width="${(1.5 + r() * 2).toFixed(1)}" stroke-linecap="round"/>`);
      }
    }
    // Mist settling below this ridge (not below the nearest).
    if (li < layers.length - 1) out.push(`<rect x="0" y="${(L.base - 40).toFixed(0)}" width="${W}" height="${(H * 0.12).toFixed(0)}" fill="url(#mist)" filter="url(#soft2)"/>`);
    // A haze of sky over the farther ridges.
    if (L.t < 0.6) out.push(`<path d="${d}" fill="#${P.haze}" fill-opacity="${((0.6 - L.t) * (dark ? 0.35 : 0.5)).toFixed(2)}"/>`);
  });

  // Pines in front, along a low rolling line.
  const hill = (x) => H * 0.93 + Math.sin(x / 310) * 18 + Math.sin(x / 120) * 6;
  let ground = `M 0 ${H}`;
  for (let x = 0; x <= W; x += 20) ground += ` L ${x} ${hill(x).toFixed(1)}`;
  out.push(`<path d="${ground} L ${W} ${H} Z" fill="#${P.trees}"/>`);
  for (let x = -20; x < W + 20; x += 9 + r() * 16) {
    // Fewer, smaller trees in the middle, so it opens up there.
    const centre = Math.abs(x / W - 0.5);
    if (centre < 0.18 && r() < 0.7) continue;
    const h = (40 + r() * 110) * (0.55 + centre * 1.1);
    const w = h * (0.28 + r() * 0.08);
    const y = hill(x) + 6;
    let t = '';
    for (let tier = 0; tier < 4; tier++) {
      const ty = y - (h * tier) / 4.2;
      const tw = w * (1 - tier * 0.22);
      t += `M ${(x - tw / 2).toFixed(1)} ${ty.toFixed(1)} L ${x.toFixed(1)} ${(ty - h * 0.42).toFixed(1)} L ${(x + tw / 2).toFixed(1)} ${ty.toFixed(1)} Z `;
    }
    out.push(`<path d="${t}" fill="#${P.trees}"/>`);
  }
  out.push(`<rect width="${W}" height="${H}" fill="url(#vig)"/>`);
  out.push('</svg>');
  return out.join('\n');
}

const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const dir = path.join(__dirname, '..', 'public', 'backdrops');
  fs.mkdirSync(dir, { recursive: true });
  // (Drawn through a canvas at exactly W×H, whatever the display's scaling.)
  const win = new BrowserWindow({ width: 400, height: 300, show: false });
  await win.loadURL('about:blank');
  for (const theme of ['dark', 'light']) {
    const svgFile = path.join(app.getPath('temp'), `kea-backdrop-${theme}.svg`);
    fs.writeFileSync(svgFile, scene(theme));
    const b64 = fs.readFileSync(svgFile).toString('base64');
    const url = await win.webContents.executeJavaScript(`new Promise((ok, no) => {
      const img = new Image();
      img.onload = () => { const c = document.createElement('canvas'); c.width = ${W}; c.height = ${H}; c.getContext('2d').drawImage(img, 0, 0, ${W}, ${H}); ok(c.toDataURL('image/jpeg', 0.88)); };
      img.onerror = () => no(new Error('the picture didn’t draw'));
      img.src = 'data:image/svg+xml;base64,${b64}';
    })`);
    const jpg = Buffer.from(url.split(',')[1], 'base64');
    fs.writeFileSync(path.join(dir, `snowy-ridge-${theme}.jpg`), jpg);
    console.log(`snowy-ridge-${theme}.jpg`, Math.round(jpg.length / 1024), 'KB');
  }
  win.destroy();
  app.quit();
});
