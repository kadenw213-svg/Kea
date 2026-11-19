// Pictures for lessons: a real, openly licensed image from Wikimedia Commons, with its credit. Kea never draws a diagram
// itself (an AI-drawn anatomy picture can put a wrong label on a real structure), and a lesson shows a picture only when
// one is found under a license that allows it. Runs only when a lesson asks for a figure.
const { ipcMain, net } = require('electron');
const { handleApp } = require('./ipcGuard.cjs');

const UA = 'Kea/1.0 (https://github.com/kadenw213-svg/kea)';
const MAX_BYTES = 3 * 1024 * 1024;

// Licenses that let a student's copy show the picture with a credit. NonCommercial and NoDerivatives never qualify.
const OPEN = /^(CC BY(?:-SA)?(?: [\d.]+)?|CC0(?: [\d.]+)?|Public domain|PD[- ]?\w*|No restrictions|Attribution(?: ShareAlike)?)\b/i;
const CLOSED = /\b(NC|ND|non-?commercial|no ?derivs?)\b/i;
/** Whether a Commons license name allows the picture to be shown with credit. */
const licenseOk = (name) => !!name && OPEN.test(String(name).trim()) && !CLOSED.test(String(name));

const plain = (html) =>
  String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

/** The best acceptable picture among Commons search results (labeled diagrams first), or null. */
function pick(pages, want) {
  const words = String(want || '').toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  const ok = Object.values(pages || {})
    .map((p) => ({ p, info: (p.imageinfo || [])[0] }))
    .filter(({ info }) => info && /^image\/(png|jpeg|svg\+xml|webp)$/.test(info.mime || '') && licenseOk(info.extmetadata?.LicenseShortName?.value))
    .map(({ p, info }) => {
      const title = String(p.title || '').toLowerCase();
      const score = (/label|diagram|annotat|structure/.test(title) ? 3 : 0) + words.filter((w) => title.includes(w)).length;
      return { p, info, score };
    })
    .sort((a, b) => b.score - a.score);
  return ok[0] || null;
}

async function find(search) {
  const q = String(search || '').trim().slice(0, 160);
  if (q.length < 3) return null;
  const url = `https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrsearch=${encodeURIComponent(`${q} filetype:bitmap|drawing`)}&gsrnamespace=6&gsrlimit=10&prop=imageinfo&iiprop=url|mime|extmetadata&iiurlwidth=900`;
  const res = await net.fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return null;
  const j = await res.json();
  const best = pick(j.query?.pages, q);
  if (!best) return null;
  const { p, info } = best;
  const src = info.thumburl || info.url;
  const img = await net.fetch(src, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) });
  if (!img.ok) return null;
  const buf = Buffer.from(await img.arrayBuffer());
  if (buf.length > MAX_BYTES) return null;
  const type = (img.headers.get('content-type') || info.mime || 'image/png').split(';')[0];
  const m = info.extmetadata || {};
  const artist = plain(m.Artist?.value) || plain(m.Credit?.value) || 'Unknown author';
  return {
    image: `data:${type};base64,${buf.toString('base64')}`,
    title: String(p.title || '').replace(/^File:/, '').replace(/\.\w+$/, ''),
    credit: `${artist.slice(0, 120)} · ${plain(m.LicenseShortName?.value)} · Wikimedia Commons`,
    page: info.descriptionurl || ''
  };
}

function register() {
  const settings = require('./settings.cjs');
  handleApp(ipcMain, 'figures:find', async (_e, search) => {
    if (settings.get('privacy.citeLookup', true) === false) return null;
    try {
      return await find(search);
    } catch {
      return null;
    }
  });
}

module.exports = { register, find, _test: { licenseOk, pick, plain } };
