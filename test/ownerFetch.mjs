// The owner console takes no owner key any more: each call answers a challenge (electron/ownerauth.cjs). Tests that
// were written with an x-kea-owner-key header call ofetch() instead, which signs the request with that key.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ownerFetch } = require('../electron/ownerauth.cjs');

/** fetch() for the owner console: the x-kea-owner-key header is used to sign, never sent. */
export function ofetch(url, init = {}) {
  const headers = { ...(init.headers || {}) };
  const key = headers['x-kea-owner-key'];
  delete headers['x-kea-owner-key'];
  const u = new URL(url);
  return ownerFetch(u.origin, key, init.method || 'GET', u.pathname + u.search, { body: init.body, headers });
}
