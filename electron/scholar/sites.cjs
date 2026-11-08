// Every connected class site read as one: one class list and one calendar from all of them (profiles.cjs keeps each
// site's own folder, engine and database). Reads go to every site and are put together; a write or a scan goes to the
// site its class, item or set is from. Ids from a site other than the first carry the site in front (profiles.qualify),
// so nothing from two sites can be mistaken for each other.
const profiles = require('./profiles.cjs');

// The fields that hold an id of something in a site's own data (an item, a class, a study set).
const ID_KEYS = new Set(['id', 'courseId', 'itemId', 'setId']);
// (Ids that aren't a site's: Kea classes, Work, scan messages' own prefixes are kept after the site's.)
const FOREIGN = /^(hub|work|org):/;

/** A site's value with its ids as the window sees them (only another site's change). */
function tag(ws, v) {
  if (!ws || ws === profiles.home()) return v;
  const walk = (x) => {
    if (Array.isArray(x)) return x.map((y) => walk(y));
    if (x && typeof x === 'object') {
      const out = {};
      for (const [k, y] of Object.entries(x)) out[k] = ID_KEYS.has(k) && (typeof y === 'string' || typeof y === 'number') && !FOREIGN.test(String(y)) ? profiles.qualify(ws, y) : walk(y);
      return out;
    }
    return x;
  };
  return walk(v);
}

/** Keys of an object map ({ itemId: value }) as the window sees them. */
const tagKeys = (ws, obj) => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [profiles.qualify(ws, k), v]));

/** fn run once in each site, in turn: [{ ws, value }]. A site that fails gives `fallback`. */
async function each(fn, fallback = null) {
  const out = [];
  for (const ws of profiles.ids()) {
    let value = fallback;
    try {
      value = await profiles.within(ws, () => fn(ws));
    } catch (err) {
      console.error(`Kea: reading ${ws}`, err?.message || err);
    }
    out.push({ ws, value });
  }
  return out;
}

/** The lists fn gives in every site, as one list (ids tagged). */
async function union(fn) {
  return (await each(fn, [])).flatMap(({ ws, value }) => (Array.isArray(value) ? value.map((x) => tag(ws, x)) : []));
}

/** fn(id as its site knows it) in the site an id from the window belongs to, its answer tagged. */
async function routed(key, fn) {
  const { ws, id } = profiles.split(key);
  return profiles.within(ws, async () => tag(ws, await fn(id, ws)));
}

/** Ids from the window grouped by site: Map ws → [id as the site knows it]. */
function bySite(keys) {
  const out = new Map();
  for (const k of keys || []) {
    const { ws, id } = profiles.split(k);
    if (!out.has(ws)) out.set(ws, []);
    out.get(ws).push(id);
  }
  return out;
}

/** A study set's id: "stream-<class>" sets are named after their class, whose id says the site. */
function splitSet(key) {
  const s = String(key ?? '');
  const m = /^stream-(.+)$/.exec(s);
  if (m) {
    const { ws, id } = profiles.split(m[1]);
    return { ws, id: `stream-${id}` };
  }
  return profiles.split(s);
}

module.exports = { tag, tagKeys, each, union, routed, bySite, splitSet, ID_KEYS };
