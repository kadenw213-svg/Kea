// An email-only account as Kea 0.82 and older made it on a computer (offline-account.json, hub null). Kea no longer
// makes these; the tests write one the way an older Kea left it, signed in, to check it keeps working.
import fs from 'node:fs';
import path from 'node:path';

export function legacyOffline(dir, email, { name = '', active = true } = {}) {
  const file = path.join(dir, 'offline-account.json');
  let j = { v: 2, active: null, accounts: {} };
  try {
    j = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  const id = `loc_legacy${Object.keys(j.accounts).length + 1}`;
  j.accounts[id] = { id, email, name, createdAt: Date.now() - 1000, lastSignIn: Date.now() - 1000, hub: null };
  if (active) j.active = id;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(j));
  return id;
}
