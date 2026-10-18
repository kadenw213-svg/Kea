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
// publisher sites) and, if chosen, any other page: the page's colours are inverted with its hue kept, then photos,
// videos and drawings are turned back so they look right. Brightspace builds most of its page inside web components,
// so the same correction is added inside each of their shadow roots too. A page that's already dark is left alone.
// Options (strength, brightness, contrast, warmth, documents, which platforms) come from Kea's settings and change live.
const PLATFORMS = [
  { id: 'd2l', test: () => /brightspace|desire2learn|d2l/i.test(location.host) || /^\/d2l\//.test(location.pathname) || !!document.querySelector('d2l-navigation, d2l-navigation-main-header') },
  { id: 'canvas', test: () => /instructure\.com|canvas/i.test(location.host) || !!document.querySelector('#application.ic-app') },
  { id: 'blackboard', test: () => /blackboard|bbcollab/i.test(location.host) || /^\/ultra\//.test(location.pathname) },
  { id: 'moodle', test: () => /moodle/i.test(location.host) || !!document.querySelector('body[id^="page-"][class*="moodle"], #page-wrapper .navbar.moodle') || typeof window.M === 'object' },
  { id: 'schoology', test: () => /schoology/i.test(location.host) },
  { id: 'classroom', test: () => /classroom\.google\.com/i.test(location.host) },
  { id: 'publishers', test: () => /pearson|mylab|mastering|aleks|mheducation|connect\.mheducation|cengage|webassign|macmillanlearning|wiley|zybooks|perusall|hawkes/i.test(location.host) }
];
// Kept as they are (turned back after the page is inverted): pictures and media, and embedded players.
const KEEP = 'img:not(picture img), picture, video, canvas, svg image, embed[type^="image"], [style*="background-image:"]:not([style*="gradient"]), iframe[src*="youtube"], iframe[src*="vimeo"], iframe[src*="kaltura"], iframe[src*="panopto"], iframe[src*="docs.google.com/presentation"], d2l-image, .d2l-course-image, .ic-DashboardCard__header_image, .course-image';
const DOCS = 'iframe[src*=".pdf"], iframe[src*="/viewer"], iframe[src*="docViewer"], object[type="application/pdf"], embed[type="application/pdf"], d2l-pdf-viewer, .d2l-fileviewer-pdf-pdfjs';

let dark = { on: false };
const isTop = window.top === window;
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
    // Selection and focus rings stay readable.
    'html.kea-dark ::selection { background: #3d6db5; color: #fff; }'
  ].join('\n');
}
// The same correction inside web components (their shadow roots don't see the page's styles).
const SHADOW = () => `:host :is(${KEEP}), :is(${KEEP}) { filter: invert(1) hue-rotate(180deg) !important; } :is(${KEEP}) :is(${KEEP}) { filter: none !important; }`;
let shadowSheet = null;
function shadowRoots(root, out = []) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  for (let n = walker.currentNode; n; n = walker.nextNode()) if (n.shadowRoot) out.push(n.shadowRoot), shadowRoots(n.shadowRoot, out);
  return out;
}
function patchShadows() {
  if (!dark.on) return;
  if (!shadowSheet) {
    try {
      shadowSheet = new CSSStyleSheet();
      shadowSheet.replaceSync(SHADOW());
    } catch {
      return;
    }
  }
  for (const r of shadowRoots(document.documentElement)) {
    try {
      if (!r.adoptedStyleSheets.includes(shadowSheet)) r.adoptedStyleSheets = [...r.adoptedStyleSheets, shadowSheet];
    } catch {}
  }
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
let observer = null;
let pending = 0;
function applyDark() {
  const html = document.documentElement;
  if (!html) return;
  const want = dark.on && (dark.sites || {})[platform()] !== false && !(isTop && !html.classList.contains('kea-dark') && alreadyDark());
  let style = document.getElementById('kea-dark-style');
  if (!want) {
    html.classList.remove('kea-dark');
    style?.remove();
    observer?.disconnect();
    observer = null;
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
  patchShadows();
  if (!observer) {
    // New parts of the page (Brightspace adds most of it after loading) get the correction too, a moment later.
    observer = new MutationObserver(() => {
      if (pending) return;
      pending = setTimeout(() => ((pending = 0), patchShadows()), 400);
    });
    observer.observe(html, { childList: true, subtree: true });
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
