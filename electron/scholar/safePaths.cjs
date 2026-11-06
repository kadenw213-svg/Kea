// Course codes and paths built from them. A class database can come from someone else (a student's classes.db in their
// Kea folder, which Kea's shared Claude works on as their device), so a course code is never trusted as a folder name:
// it must be a plain code, and every path built from it must stay inside the folder it was meant for. The same rule is
// in the engine (scholar/engine/src/academic_sync/safe_paths.py).
const path = require('path');

const CODE_RE = /^[A-Za-z0-9 ._-]{1,40}$/;

/** Whether a course code is safe to use in a folder or file name. */
function validCode(code) {
  const c = typeof code === 'string' ? code : '';
  return CODE_RE.test(c) && !c.includes('..') && c.replace(/[ .]/g, '') !== '';
}

/** The course code, or an error when it can't be used in a path. */
function safeCode(code) {
  if (!validCode(code)) throw new Error(`The course code “${String(code).slice(0, 60)}” can’t be used as a folder name.`);
  return code;
}

/** Whether `p` (resolved) is `root` or inside it. */
function isInside(root, p) {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/** path.join(root, ...parts), refusing a result outside `root` (".." or an absolute part in a code or name). */
function within(root, ...parts) {
  const p = path.resolve(root, ...parts.map(String));
  if (!isInside(root, p)) throw new Error(`${parts.join('/').slice(0, 80)} would be outside ${root}.`);
  return p;
}

module.exports = { validCode, safeCode, isInside, within, CODE_RE };
