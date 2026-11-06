// A signed-in request that checks every redirect BEFORE following it, instead of finding out where it went afterwards
// (by then the session's cookies and the address's query string have already reached that host). Electron's fetch can't
// do this (redirect:'manual' just fails, without saying where it was going), so this is its ClientRequest underneath.
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

/**
 * GET `url` with the session's cookies. `allow(next, from)` decides each redirect; a refused one rejects with an error
 * carrying `refusedHop` (the address, which is never contacted). Resolves to what callers use of a fetch Response, with
 * the whole body read.
 */
function fetchHops(net, ses, url, allow = publicHttps) {
  return new Promise((resolve, reject) => {
    let cur = String(url);
    let hops = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const req = net.request({ url: cur, method: 'GET', session: ses, redirect: 'manual', useSessionCookies: true, credentials: 'include' });
    req.on('redirect', (_status, _method, next) => {
      if (settled) return;
      let ok = false;
      try {
        ok = ++hops <= MAX_HOPS && allow(next, cur) === true;
      } catch {}
      if (!ok) {
        const err = new Error(hops > MAX_HOPS ? 'That address redirects too many times.' : 'That address redirects to a site Kea doesn’t read.');
        err.refusedHop = next;
        fail(err);
        // (Not following it in this event cancels the request; the error that causes is ignored above.)
        return;
      }
      cur = next;
      req.followRedirect();
    });
    req.on('response', (res) => {
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
    req.on('error', fail);
    req.end();
  });
}

module.exports = { fetchHops, publicHttps };
