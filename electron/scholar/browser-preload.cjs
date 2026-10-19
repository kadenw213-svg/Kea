// Runs in Kea's class-site window (not in Kea itself). Two jobs:
//  - when the user signs in and asked Kea to remember it, report the login form they submitted to Kea's main process
//    (which keeps it only in that case, encrypted);
//  - fill in and submit that saved login when Kea signs in for them. Kea sends it here over its private channel, so
//    the web page's own scripts never see it.
const { ipcRenderer } = require('electron');

const visible = (el) => !!el && el.offsetParent !== null && !el.disabled;
const textInputs = (root) => [...root.querySelectorAll('input[type=text], input[type=email], input:not([type])')].filter(visible);

let remembering = null;
function report(form) {
  // Only while the user is signing in and asked Kea to remember it; otherwise nothing leaves the page.
  const root = form && form.querySelector ? form : document;
  if (remembering === null) remembering = !!ipcRenderer.sendSync('class-site:remembering');
  if (!remembering) return;
  const pw = [...root.querySelectorAll('input[type=password]')].find((x) => x.value);
  const user = textInputs(pw && pw.form ? pw.form : root).find((x) => x.value);
  // A name-only first step ("Next") is reported too, so a two-step login can be put back together.
  if (!pw && !user) return;
  ipcRenderer.send('class-site:login', { url: location.href, user: user ? user.value : '', pass: pw ? pw.value : '', userField: user ? user.name || user.id : '', passField: pw ? pw.name || pw.id : '' });
}
// Sign-in pages send their form in different ways (a real submit, a button with a script, pressing Enter), so each
// is noticed, and so is the page moving on with the fields still filled in.
document.addEventListener('submit', (e) => report(e.target), true);
document.addEventListener(
  'click',
  (e) => {
    const b = e.target && e.target.closest && e.target.closest('button, input[type=submit], input[type=button], a[role=button], [onclick]');
    if (b) report(b.form || null);
  },
  true
);
document.addEventListener(
  'keydown',
  (e) => {
    if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT') report(e.target.form || null);
  },
  true
);
window.addEventListener('pagehide', () => report(null), true);

function setValue(el, v) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
  setter.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
function submit(form, near) {
  // Press the page's own button, so its scripts run (some sign-in pages copy the name into a hidden field on click).
  const root = form || document;
  const named = [...root.querySelectorAll('button, input[type=submit], input[type=button]')].find((b) => visible(b) && /sign ?in|log ?in|next|continue|submit/i.test(b.innerText || b.value || ''));
  const btn = named || root.querySelector('button[type=submit], input[type=submit], button:not([type])');
  if (btn && visible(btn)) btn.click();
  else if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
  else if (near) near.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

/** Fill in one step of the sign-in page with the saved login. True if something was filled and submitted. */
function fill(login) {
  const byName = (n) => (n ? document.querySelector(`input[name="${CSS.escape(n)}"], #${CSS.escape(n)}`) : null);
  const pw = (visible(byName(login.passField)) && byName(login.passField)) || [...document.querySelectorAll('input[type=password]')].find(visible);
  const user = (visible(byName(login.userField)) && byName(login.userField)) || textInputs(pw && pw.form ? pw.form : document)[0];
  if (pw) {
    if (user && !user.value && login.user) setValue(user, login.user);
    setValue(pw, login.pass);
    submit(pw.form, pw);
    return true;
  }
  if (user && login.user) {
    setValue(user, login.user);
    submit(user.form, user);
    return true;
  }
  // "Stay signed in?" pages.
  const yes = document.querySelector('#idSIButton9, input[type=submit][value="Yes"]');
  if (visible(yes)) {
    yes.click();
    return true;
  }
  return false;
}

ipcRenderer.on('class-site:fill', (_e, login) => ipcRenderer.send('class-site:filled', fill(login)));

// ---------- Dark mode for class sites ----------
// Kea's own dark theme for school platforms (D2L Brightspace, Canvas, Blackboard, Moodle, Schoology, Google Classroom,
// publisher sites) and, if chosen, any other page: the page's colours are inverted with its hue kept, then photos and
// videos are turned back so they look right. Drawings, symbols and formulas on a see-through or plain white background
// stay inverted with the page (light on dark, like the text around them): turning those back put black characters on
// the dark page, which is how symbols on ALEKS and math pages went missing. The site's header takes Kea's own colours.
// Brightspace builds most of its page inside web components, so the same correction is added inside each of their
// shadow roots too. A page that's already dark is left alone. Options come from Kea's settings and change live.
const PLATFORMS = [
  { id: 'd2l', test: () => /brightspace|desire2learn|d2l/i.test(location.host) || /^\/d2l\//.test(location.pathname) || !!document.querySelector('d2l-navigation, d2l-navigation-main-header') },
  { id: 'canvas', test: () => /instructure\.com|canvas/i.test(location.host) || !!document.querySelector('#application.ic-app') },
  { id: 'blackboard', test: () => /blackboard|bbcollab/i.test(location.host) || /^\/ultra\//.test(location.pathname) },
  { id: 'moodle', test: () => /moodle/i.test(location.host) || !!document.querySelector('body[id^="page-"][class*="moodle"], #page-wrapper .navbar.moodle') || typeof window.M === 'object' },
  { id: 'schoology', test: () => /schoology/i.test(location.host) },
  { id: 'classroom', test: () => /classroom\.google\.com/i.test(location.host) },
  { id: 'publishers', test: () => /pearson|mylab|mastering|aleks|mheducation|connect\.mheducation|cengage|webassign|macmillanlearning|wiley|zybooks|perusall|hawkes/i.test(location.host) }
];
// Turned back after the page is inverted: videos and embedded players always, and pictures Kea has looked at and
// found to be photos (marked data-kea-keep, see classify).
const KEEP = '[data-kea-keep], video, embed[type^="image"], svg image, iframe[src*="youtube"], iframe[src*="vimeo"], iframe[src*="kaltura"], iframe[src*="panopto"], iframe[src*="docs.google.com/presentation"], .d2l-course-image, .ic-DashboardCard__header_image, .course-image';
const DOCS = 'iframe[src*=".pdf"], iframe[src*="/viewer"], iframe[src*="docViewer"], object[type="application/pdf"], embed[type="application/pdf"], d2l-pdf-viewer, .d2l-fileviewer-pdf-pdfjs';

let dark = { on: false };
const isTop = window.top === window;

// ----- Kea's colours through the page's filter -----
// The page filter is a chain of simple colour sums (invert, hue turn, brightness, contrast, warmth), so it can be run
// backwards: the colour to give the header so that, once filtered, it shows as Kea's exact colour.
function filterSteps() {
  const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const mul = (M, N) => M.map((r) => [0, 1, 2].map((j) => r[0] * N[0][j] + r[1] * N[1][j] + r[2] * N[2][j]));
  const app = (M, v) => M.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
  const scale = (k) => I.map((r) => r.map((x) => x * k));
  let A = I;
  let t = [0, 0, 0];
  const step = (M, u = [0, 0, 0]) => {
    A = mul(M, A);
    t = app(M, t).map((x, i) => x + u[i]);
  };
  const s = dark.strength;
  step(scale(1 - 2 * s), [s, s, s]);
  step([[-0.574, 1.43, 0.144], [0.426, 0.43, 0.144], [0.426, 1.43, -0.856]]);
  step(scale(dark.brightness));
  const c = dark.contrast;
  step(scale(c), [0.5 - 0.5 * c, 0.5 - 0.5 * c, 0.5 - 0.5 * c]);
  const p = dark.sepia;
  const S = [[0.393, 0.769, 0.189], [0.349, 0.686, 0.168], [0.272, 0.534, 0.131]];
  step(I.map((r, i) => r.map((x, j) => (1 - p) * x + p * S[i][j])));
  return { A, t };
}
function beforeFilter(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const want = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x) => x / 255);
  const { A, t } = filterSteps();
  const [[a, b, c], [d, e, f], [g, h, i]] = A;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-6) return hex;
  const inv = [
    [e * i - f * h, c * h - b * i, b * f - c * e],
    [f * g - d * i, a * i - c * g, c * d - a * f],
    [d * h - e * g, b * g - a * h, a * e - b * d]
  ].map((r) => r.map((x) => x / det));
  const y = want.map((x, k) => x - t[k]);
  const v = inv.map((r) => r[0] * y[0] + r[1] * y[1] + r[2] * y[2]);
  return '#' + v.map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0')).join('');
}
/** The site's own header bar and brand colour in Kea's colours (D2L, Canvas, Moodle). */
function headerRules(shadow) {
  const k = dark.header && dark.theme;
  if (!k) return '';
  const bg = beforeFilter(k.surface);
  const text = beforeFilter(k.text);
  const acc = beforeFilter(k.accent);
  const on = beforeFilter(k.onAccent);
  if (shadow) return `:host(d2l-navigation-band) { background: ${acc} !important; } :host(d2l-navigation-main-header), :host(d2l-navigation-main-footer) { background: ${bg} !important; }`;
  return [
    `html.kea-dark { --d2l-branding-primary-color: ${acc}; --ic-brand-global-nav-bgd: ${bg}; --ic-brand-global-nav-logo-bgd: ${bg}; --ic-brand-global-nav-ic-icon-svg-fill: ${text}; --ic-brand-global-nav-menu-item__text-color: ${text}; --ic-brand-global-nav-ic-icon-svg-fill--active: ${acc}; --ic-brand-global-nav-menu-item__text-color--active: ${acc}; --ic-brand-primary: ${acc}; --ic-link-color: ${acc}; --ic-brand-button--primary-bgd: ${acc}; --ic-brand-button--primary-text: ${on}; }`,
    `html.kea-dark d2l-navigation-band { background: ${acc} !important; }`,
    `html.kea-dark :is(d2l-navigation-main-header, d2l-navigation-main-footer) { background: ${bg} !important; }`,
    `html.kea-dark #header.ic-app-header { background: ${bg} !important; box-shadow: inset -3px 0 0 ${acc}; }`,
    `html.kea-dark nav.navbar.fixed-top { background: ${bg} !important; box-shadow: inset 0 -3px 0 ${acc}; }`
  ].join('\n');
}

function sheetText() {
  const f = `invert(${dark.strength}) hue-rotate(180deg) brightness(${dark.brightness}) contrast(${dark.contrast}) sepia(${dark.sepia})`;
  const back = 'invert(1) hue-rotate(180deg)';
  return [
    // The whole page, once, from the top document (frames inside it are inverted with it).
    isTop ? `html.kea-dark { filter: ${f} !important; background: #fff !important; }` : '',
    `html.kea-dark :is(${KEEP}) { filter: ${back} !important; }`,
    // Media inside something already turned back mustn't be turned twice.
    `html.kea-dark :is(${KEEP}) :is(${KEEP}) { filter: none !important; }`,
    dark.docs ? '' : `html.kea-dark :is(${DOCS}) { filter: ${back} !important; }`,
    // Selection stays readable.
    'html.kea-dark ::selection { background: #3d6db5; color: #fff; }',
    isTop ? headerRules(false) : ''
  ].join('\n');
}
// The same correction inside web components (their shadow roots don't see the page's styles).
const SHADOW = () => `:is(${KEEP}) { filter: invert(1) hue-rotate(180deg) !important; } :is(${KEEP}) :is(${KEEP}) { filter: none !important; } ${headerRules(true)}`;

// ----- Which pictures are photos -----
// Each picture is looked at once, as a 16×16 copy: see-through parts mean a drawing, symbol or formula, and black and
// white on a white page means a scan or diagram; both stay inverted with the page. The rest are photos and keep their
// colours. A picture from another site that the page isn't allowed to read is judged by its kind and size.
const verdicts = new Map();
function sample(source) {
  try {
    // A fresh canvas each time: one that has drawn an unreadable picture stays unreadable.
    const c = document.createElement('canvas');
    c.width = c.height = 16;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, 16, 16);
    return ctx.getImageData(0, 0, 16, 16).data;
  } catch {
    return null;
  }
}
function looksLikePhoto(data) {
  let clear = 0;
  let light = 0;
  let grey = 0;
  const n = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 200) {
      clear++;
      continue;
    }
    const hi = Math.max(data[i], data[i + 1], data[i + 2]);
    const lo = Math.min(data[i], data[i + 1], data[i + 2]);
    if (lo > 225) light++;
    if (hi - lo < 24) grey++;
  }
  if (clear > n * 0.04) return false;
  if (light > n * 0.5 && grey > n * 0.85) return false;
  return true;
}
function guess(src, w, h) {
  const ext = ((/\.([a-z0-9]{3,4})$/i.exec(src.split(/[?#]/)[0]) || [])[1] || '').toLowerCase();
  if (/^data:image\/(jpe?g|webp|avif)/i.test(src) || ['jpg', 'jpeg', 'webp', 'avif'].includes(ext)) return true;
  if (ext === 'svg' || /^data:image\/svg/i.test(src)) return false;
  return w >= 200 && h >= 150;
}
function classify(el) {
  let keep;
  if (el.tagName === 'IMG') {
    if (!el.complete || !el.naturalWidth) {
      if (!el.__keaWait) {
        el.__keaWait = true;
        el.addEventListener('load', () => ((el.__keaWait = false), classify(el)), { once: true });
      }
      return;
    }
    const src = el.currentSrc || el.src;
    if (!verdicts.has(src)) {
      const d = sample(el);
      verdicts.set(src, d ? looksLikePhoto(d) : guess(src, el.naturalWidth, el.naturalHeight));
    }
    keep = verdicts.get(src);
  } else if (el.tagName === 'CANVAS') {
    if (!el.width || !el.height) return;
    // Drawn again and again, so looked at each time. Unreadable (from another site, or 3D) keeps its colours.
    const d = sample(el);
    keep = !d || !d.some((x, i) => i % 4 === 3 && x > 0) || looksLikePhoto(d);
  } else {
    const url = (/url\(["']?([^"')]+)/.exec(el.getAttribute('style') || '') || [])[1];
    if (!url) return;
    keep = guess(url, 0, 0);
  }
  if (keep !== el.hasAttribute('data-kea-keep')) keep ? el.setAttribute('data-kea-keep', '') : el.removeAttribute('data-kea-keep');
}

let shadowSheet = null;
function shadowRoots(root, out = []) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  for (let n = walker.currentNode; n; n = walker.nextNode()) if (n.shadowRoot) out.push(n.shadowRoot), shadowRoots(n.shadowRoot, out);
  return out;
}
/** Patch new shadow roots and look at new pictures. */
function sweep() {
  if (!dark.on || !document.documentElement || !document.documentElement.classList.contains('kea-dark')) return;
  if (!shadowSheet) {
    try {
      shadowSheet = new CSSStyleSheet();
      shadowSheet.replaceSync(SHADOW());
    } catch {
      shadowSheet = null;
    }
  }
  const roots = shadowRoots(document.documentElement);
  for (const r of roots) {
    try {
      if (shadowSheet && !r.adoptedStyleSheets.includes(shadowSheet)) r.adoptedStyleSheets = [...r.adoptedStyleSheets, shadowSheet];
    } catch {}
  }
  for (const r of [document, ...roots]) for (const el of r.querySelectorAll('img, canvas, [style*="background-image"]')) classify(el);
}
function unpatchShadows() {
  if (!shadowSheet) return;
  for (const r of shadowRoots(document.documentElement)) {
    try {
      r.adoptedStyleSheets = r.adoptedStyleSheets.filter((s) => s !== shadowSheet);
    } catch {}
  }
}
/** Whether the page is already dark (its own dark theme): then inverting would make it light. */
function alreadyDark() {
  const lum = (el) => {
    if (!el) return null;
    const m = getComputedStyle(el).backgroundColor.match(/[\d.]+/g);
    if (!m || (m[3] !== undefined && Number(m[3]) < 0.5)) return null;
    const [r, g, b] = m.map(Number);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  };
  const l = lum(document.body) ?? lum(document.documentElement);
  return l !== null && l < 0.35;
}
function platform() {
  const p = PLATFORMS.find((x) => {
    try {
      return x.test();
    } catch {
      return false;
    }
  });
  return p ? p.id : 'other';
}
/** Sites the student turned dark mode off for (right-click in the class-site window). */
function offHere() {
  let host = location.hostname;
  try {
    host = window.top.location.hostname;
  } catch {}
  return (dark.offHosts || []).some((h) => host === h || host.endsWith('.' + h));
}
let observer = null;
let pending = 0;
let timer = 0;
function applyDark() {
  const html = document.documentElement;
  if (!html) return;
  const want = dark.on && (dark.sites || {})[platform()] !== false && !offHere() && !(isTop && !html.classList.contains('kea-dark') && alreadyDark());
  let style = document.getElementById('kea-dark-style');
  if (!want) {
    html.classList.remove('kea-dark');
    style?.remove();
    observer?.disconnect();
    observer = null;
    clearInterval(timer);
    timer = 0;
    unpatchShadows();
    return;
  }
  if (!style) {
    style = document.createElement('style');
    style.id = 'kea-dark-style';
    (document.head || html).appendChild(style);
  }
  style.textContent = sheetText();
  html.classList.add('kea-dark');
  sweep();
  if (!observer) {
    // New parts of the page (Brightspace adds most of it after loading) get the correction too, a moment later.
    observer = new MutationObserver(() => {
      if (pending) return;
      pending = setTimeout(() => ((pending = 0), sweep()), 400);
    });
    observer.observe(html, { childList: true, subtree: true });
    // Pictures inside web components load without the page hearing, and drawings change: looked at now and then.
    timer = setInterval(sweep, 2500);
  }
}
function setDark(next) {
  dark = { strength: 0.9, brightness: 1, contrast: 1, sepia: 0, docs: false, sites: {}, ...next };
  if (shadowSheet) shadowSheet.replaceSync(SHADOW());
  if (document.documentElement) applyDark();
}
try {
  setDark(ipcRenderer.sendSync('class-site:dark') || { on: false });
} catch {}
ipcRenderer.on('class-site:dark', (_e, next) => setDark(next));
// Early, so the page doesn't flash white; again once it's built (to see which platform it is and whether it's dark).
document.addEventListener('readystatechange', () => applyDark());
window.addEventListener('load', () => applyDark());
// Pictures in the page itself are looked at as they arrive.
document.addEventListener('load', (e) => e.target && e.target.tagName === 'IMG' && document.documentElement.classList.contains('kea-dark') && classify(e.target), true);
