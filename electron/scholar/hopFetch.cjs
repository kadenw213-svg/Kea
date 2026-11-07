// A signed-in request that checks every redirect BEFORE following it, instead of finding out where it went afterwards
// (by then the session's cookies and the address's query string have already reached that host). Electron's fetch can't
// do this (redirect:'manual' just fails, without saying where it was going), so this is its ClientRequest underneath.
// Every address, the first and each redirect, must also resolve only to addresses out on the internet: a public name
// that points at this computer or the home network ("127.0.0.1.nip.io") is refused before it's contacted.
const nodeNet = require('net');
const MAX_HOPS = 10;

/** https, on a named host out on the internet: never this computer, a bare local name or an address by its numbers. */
function publicHttps(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host.includes('.') || /^\[|^[\d.]+$|^0x/.test(host)) return false;
  return !/(^|\.)(localhost|local|internal|intranet|lan|home\.arpa)$/.test(host);
}

/** An IPv4 address as its four numbers, or null. */
const v4 = (a) => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  return m && m.slice(1).every((x) => +x <= 255) ? m.slice(1).map(Number) : null;
};
/**
 * Whether an IP address is somewhere Kea never fetches from: this computer (loopback), the home or school network
 * (private, link-local, carrier-grade NAT, unique local), unspecified, multicast or reserved. Anything it can't read
 * counts as private.
 */
function privateAddress(addr) {
  const a = String(addr || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/, '');
  const four = v4(a);
  if (four) {
    const [x, y] = four;
    return (
      x === 0 || // this network
      x === 10 ||
      x === 127 ||
      (x === 100 && y >= 64 && y <= 127) || // carrier-grade NAT
      (x === 169 && y === 254) || // link-local (and cloud metadata)
      (x === 172 && y >= 16 && y <= 31) ||
      (x === 192 && y === 168) ||
      (x === 192 && y === 0 && four[2] === 0) ||
      (x === 198 && (y === 18 || y === 19)) || // benchmarking
      x >= 224 // multicast, reserved, broadcast
    );
  }
  if (nodeNet.isIPv6(a)) {
    // An IPv4 address carried in IPv6 (::ffff:10.0.0.1, ::ffff:a00:1, 64:ff9b::a00:1): judged as that address.
    const tail = /^(?:::ffff:(?:0:)?|64:ff9b::)(.+)$/.exec(a);
    if (tail) {
      if (v4(tail[1])) return privateAddress(tail[1]);
      const h = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail[1]);
      if (!h) return true;
      const n = parseInt(h[1], 16) * 65536 + parseInt(h[2], 16);
      return privateAddress([Math.floor(n / 16777216) % 256, Math.floor(n / 65536) % 256, Math.floor(n / 256) % 256, n % 256].join('.'));
    }
    if (a === '::' || a === '::1') return true;
    const first = parseInt(a.split(':')[0] || '0', 16);
    return (
      (first & 0xfe00) === 0xfc00 || // unique local fc00::/7
      (first & 0xffc0) === 0xfe80 || // link-local fe80::/10
      (first & 0xffc0) === 0xfec0 || // old site-local
      (first & 0xff00) === 0xff00 // multicast
    );
  }
  return true;
}

/**
 * Look the address's host up (every address it has) and refuse it when any is private (privateAddress), or when it
 * can't be looked up. `trusted(host)` skips the check for a host the student set up themselves (their class site,
 * which a school network may serve from its own addresses). Rejects with `refusedHop` when it may not be contacted.
 */
async function checkResolved(url, lookup, trusted) {
  const host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  if (trusted && trusted(host)) return;
  let addrs = [];
  try {
    addrs = await lookup(host, { all: true, verbatim: true });
  } catch {
    addrs = [];
  }
  const list = [].concat(addrs || []).map((x) => (typeof x === 'string' ? x : x && x.address)).filter(Boolean);
  if (!list.length || list.some(privateAddress)) {
    const err = new Error(list.length ? 'That address leads to this computer or a local network, which Kea doesn’t read.' : `Kea couldn’t look up ${host}.`);
    err.refusedHop = String(url);
    throw err;
  }
}

/**
 * GET `url` with the session's cookies. `allow(next, from)` decides each redirect; a refused one rejects with an error
 * carrying `refusedHop` (the address, which is never contacted). Resolves to what callers use of a fetch Response, with
 * the whole body read. The first address must be https on a public host too, whatever `allow` is, and every address
 * must resolve to public ones: this never reaches this computer or the home network, even if a caller forgot to check.
 * `opts.lookup` is dns.promises.lookup (or a stand-in, in tests); `opts.trusted(host)` names hosts exempt from the
 * resolved-address check.
 */
function fetchHops(net, ses, url, allow = publicHttps, opts = {}) {
  const lookup = opts.lookup || require('dns').promises.lookup;
  return new Promise((resolve, reject) => {
    if (!publicHttps(url)) {
      const err = new Error('Kea only fetches https addresses on the internet.');
      err.refusedHop = String(url);
      return reject(err);
    }
    let cur = String(url);
    let hops = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    // One request per address. A redirect's target is checked (allow, then its addresses) before a new request goes
    // there; the old one is let go without following, since the lookup can't happen inside the redirect event.
    const go = (target) => {
      let moved = false;
      const req = net.request({ url: target, method: 'GET', session: ses, redirect: 'manual', useSessionCookies: true, credentials: 'include' });
      req.on('redirect', (_status, _method, next) => {
        if (settled || moved) return;
        moved = true;
        let ok = false;
        try {
          ok = ++hops <= MAX_HOPS && publicHttps(next) && allow(next, cur) === true;
        } catch {}
        // (Not following it in this event cancels the request; the error that causes is ignored below.)
        try {
          req.abort?.();
        } catch {}
        if (!ok) {
          const err = new Error(hops > MAX_HOPS ? 'That address redirects too many times.' : 'That address redirects to a site Kea doesn’t read.');
          err.refusedHop = next;
          return fail(err);
        }
        checkResolved(next, lookup, opts.trusted).then(() => {
          if (settled) return;
          cur = next;
          go(next);
        }, fail);
      });
      req.on('response', (res) => {
        if (moved) return;
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('error', fail);
        res.on('end', () => {
          if (settled) return;
          settled = true;
          const body = Buffer.concat(chunks);
          const headers = new Headers();
          for (const [k, v] of Object.entries(res.headers || {})) for (const one of [].concat(v)) headers.append(k, String(one));
          resolve({
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            url: cur,
            headers,
            text: async () => body.toString('utf8'),
            json: async () => JSON.parse(body.toString('utf8')),
            arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length)
          });
        });
      });
      req.on('error', (err) => {
        if (!moved) fail(err);
      });
      req.end();
    };
    checkResolved(cur, lookup, opts.trusted).then(() => {
      if (!settled) go(cur);
    }, fail);
  });
}

module.exports = { fetchHops, publicHttps, privateAddress };
