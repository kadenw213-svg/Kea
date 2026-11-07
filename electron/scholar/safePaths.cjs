// Course codes and paths built from them. A class database can come from someone else (a student's classes.db in their
// Kea folder, which Kea's shared Claude works on as their device), so a course code is never trusted as a folder name:
// it must be a plain code, and every path built from it must stay inside the folder it was meant for. The same rule is
// in the engine (scholar/engine/src/academic_sync/safe_paths.py).
const path = require('path');

const CODE_RE = /^[A-Za-z0-9 ._-]{1,40}$/;
// Windows device names, in any case, with or without an extension: "CON" or "nul.txt" as a folder or file name reaches
// the device, not a file.
const RESERVED_RE = /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9]) *(\..*)?$/i;

/** Whether a course code is safe to use in a folder or file name. */
function validCode(code) {
  const c = typeof code === 'string' ? code : '';
  // (Windows drops a final dot or space, so "BIO1010." would be the folder "BIO1010".)
  return CODE_RE.test(c) && !c.includes('..') && c.replace(/[ .]/g, '') !== '' && !/[ .]$/.test(c) && !RESERVED_RE.test(c.trim());
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

const NAME_MAX = 120;
/**
 * A file name from somewhere else (a classmate's shared folder, a Hub) made safe to write: one plain name, never a path.
 * Separators, characters Windows refuses and control characters become spaces; a trailing dot or space goes (Windows
 * drops it, so it could name another file); a Windows device name ("CON", "nul.txt") gets a "_" in front; a long name
 * is cut to NAME_MAX characters, keeping its extension. Null when nothing usable is left ("..", "", "...").
 */
function safeFileName(name) {
  let n = String(name ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  if (!n || n.replace(/[ .]/g, '') === '') return null;
  if (RESERVED_RE.test(n)) n = `_${n}`;
  if (n.length > NAME_MAX) {
    const ext = (/\.[A-Za-z0-9]{1,8}$/.exec(n) || [''])[0];
    n = `${n.slice(0, NAME_MAX - ext.length).replace(/[. ]+$/, '')}${ext}`;
  }
  return n;
}

module.exports = { validCode, safeCode, safeFileName, isInside, within, CODE_RE };
