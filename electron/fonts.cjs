// Installed font files by family name, so a PDF can embed the real font a text box uses (Bahnschrift, Georgia,
// Segoe UI…) instead of only the 14 standard PDF fonts. Windows: the font registry (machine and per-user fonts);
// macOS / Linux: the usual font folders, matched by file name.
const { ipcMain } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let index = null; // [{ name: 'Segoe UI Bold', file }]

function regQuery(key) {
  return new Promise((resolve) => execFile('reg.exe', ['query', key], { windowsHide: true, maxBuffer: 4e6 }, (err, out) => resolve(err ? '' : String(out))));
}

async function buildIndex() {
  if (index) return index;
  const out = [];
  if (process.platform === 'win32') {
    const winFonts = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts');
    for (const key of ['HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts', 'HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts']) {
      for (const line of (await regQuery(key)).split(/\r?\n/)) {
        const m = /^\s{2,}(.+?)\s+REG_SZ\s+(.+)$/.exec(line);
        if (!m) continue;
        const file = path.isAbsolute(m[2].trim()) ? m[2].trim() : path.join(winFonts, m[2].trim());
        if (!/\.(ttf|otf|ttc)$/i.test(file)) continue;
        // "Cambria & Cambria Math (TrueType)" names two families in one collection file.
        for (const name of m[1].replace(/\s*\((TrueType|OpenType)\)\s*$/i, '').split(/\s*&\s*/)) out.push({ name: name.trim(), file });
      }
    }
  } else {
    const dirs = ['/Library/Fonts', '/System/Library/Fonts', '/System/Library/Fonts/Supplemental', path.join(os.homedir(), 'Library', 'Fonts'), '/usr/share/fonts', path.join(os.homedir(), '.fonts')];
    const walk = (d, depth) => {
      let list = [];
      try {
        list = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of list) {
        const f = path.join(d, e.name);
        if (e.isDirectory() && depth < 3) walk(f, depth + 1);
        else if (/\.(ttf|otf|ttc)$/i.test(e.name)) out.push({ name: e.name.replace(/\.(ttf|otf|ttc)$/i, '').replace(/[-_]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2'), file: f });
      }
    };
    for (const d of dirs) walk(d, 0);
  }
  index = out;
  return out;
}

/** The best file for a family and style: an exact "Family Bold Italic" entry, else the family's regular file. */
async function find(family, bold, italic) {
  const fam = String(family || '').trim().toLowerCase();
  if (!fam) return null;
  const want = [bold ? 'bold' : '', italic ? 'italic' : ''].filter(Boolean);
  const scored = [];
  for (const e of await buildIndex()) {
    const n = e.name.toLowerCase();
    if (n !== fam && !n.startsWith(`${fam} `)) continue;
    const rest = n.slice(fam.length).trim().split(/\s+/).filter(Boolean).map((w) => (w === 'oblique' ? 'italic' : w));
    const extra = rest.filter((w) => !['bold', 'italic', 'regular'].includes(w)).length;
    const missing = want.filter((w) => !rest.includes(w)).length;
    const unwanted = rest.filter((w) => (w === 'bold' && !bold) || (w === 'italic' && !italic)).length;
    scored.push({ e, score: missing * 10 + unwanted * 10 + extra * 3 });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored[0] ? scored[0].e : null;
}

function register() {
  ipcMain.handle('fonts:file', async (_e, family, bold, italic) => {
    const hit = await find(family, !!bold, !!italic);
    if (!hit) return null;
    try {
      return { file: hit.file, name: hit.name, data: new Uint8Array(fs.readFileSync(hit.file)) };
    } catch {
      return null;
    }
  });
}

module.exports = { register, _find: find };
