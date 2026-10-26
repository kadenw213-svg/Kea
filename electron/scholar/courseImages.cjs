// Each class's picture from the class site (D2L's course image, Canvas's course card image), kept small in the profile
// so Home can show it on the class's card, here and on the phone. Read once, then again every few weeks; a class with no
// picture is remembered as such and asked again on the same schedule.
const fs = require('fs');
const path = require('path');
const { nativeImage } = require('electron');
const profiles = require('./profiles.cjs');
const browser = require('./browser.cjs');
const db = require('./db.cjs');

const MAX_AGE = 21 * 864e5;
const dir = () => path.join(profiles.paths().dir, 'course-images');
const safe = (code) => String(code).replace(/[^A-Za-z0-9_-]/g, '_');
const fileOf = (code) => path.join(dir(), `${safe(code)}.jpg`);
const noneOf = (code) => path.join(dir(), `${safe(code)}.none`);
const fresh = (f) => fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < MAX_AGE;
const touch = (f) => (fs.mkdirSync(path.dirname(f), { recursive: true }), fs.writeFileSync(f, ''));

/** The class site's address of a class's picture, or null when it has none. */
async function sourceOf(ou, lp) {
  if (browser.platformOf() === 'canvas') {
    const r = await browser.getJson(`/api/v1/courses/${ou}?include[]=course_image`);
    return r.data?.image_download_url || null;
  }
  return `/d2l/api/lp/${lp}/courses/${ou}/image?width=800&height=450`;
}

let running = null;
/** Reads the pictures that are missing or old (all of them with `force`). Returns how many changed. */
function refresh({ force = false } = {}) {
  if (running) return running;
  running = (async () => {
    const P = profiles.paths();
    const list = (await db.watchList(P.db)).filter((c) => force || !(fresh(fileOf(c.code)) || fresh(noneOf(c.code))));
    if (!list.length) return 0;
    const home = browser.schoolInfo().home;
    if (!home || !(await browser.status().catch(() => ({}))).signedIn) return 0;
    let lp = '1.47';
    if (browser.platformOf() !== 'canvas') {
      const v = await browser.getJson('/d2l/api/versions/').catch(() => null);
      lp = (v?.data || []).find((p) => p.ProductCode === 'lp')?.LatestVersion || lp;
    }
    let changed = 0;
    for (const c of list) {
      try {
        const src = await sourceOf(c.ou, lp);
        if (!src) {
          touch(noneOf(c.code));
          continue;
        }
        const got = await browser.download(new URL(src, home).href, `course-images/${safe(c.code)}`);
        const tmp = path.join(P.workspace, got.saved);
        const img = nativeImage.createFromBuffer(fs.readFileSync(tmp));
        fs.rmSync(tmp, { force: true });
        if (img.isEmpty()) {
          touch(noneOf(c.code));
          continue;
        }
        fs.mkdirSync(dir(), { recursive: true });
        fs.writeFileSync(fileOf(c.code), img.resize({ width: 480, quality: 'good' }).toJPEG(74));
        fs.rmSync(noneOf(c.code), { force: true });
        changed++;
      } catch (err) {
        // (No picture set answers 404; anything else is tried again next time.)
        if (/\b40[34]\b/.test(String(err?.message))) touch(noneOf(c.code));
      }
    }
    return changed;
  })().finally(() => (running = null));
  return running;
}

const cache = new Map();
/** A class's picture as a data address (small JPEG), or null. */
function imageOf(code) {
  const f = fileOf(code);
  let st;
  try {
    st = fs.statSync(f);
  } catch {
    return null;
  }
  const hit = cache.get(f);
  if (hit && hit.at === st.mtimeMs) return hit.url;
  const url = `data:image/jpeg;base64,${fs.readFileSync(f).toString('base64')}`;
  cache.set(f, { at: st.mtimeMs, url });
  return url;
}

/** Courses with their pictures. */
const withImages = (courses) => courses.map((c) => ({ ...c, image: imageOf(c.code) }));

module.exports = { refresh, imageOf, withImages };
