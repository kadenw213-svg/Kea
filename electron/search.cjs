// "Search inside files": looks for words in the text of documents in the user's folders.
// Reads plain-text formats directly and Office/OpenDocument files by unzipping their XML.
// Files that are only stored online (OneDrive placeholders) are skipped so a search never
// downloads anything.
const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { execFile } = require('child_process');

const TEXT_EXT = new Set(['txt', 'md', 'csv', 'tsv', 'json', 'html', 'htm', 'xml', 'log', 'rtf', 'yaml', 'yml', 'ini']);
const ZIP_EXT = new Set(['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp']);
const MAX_BYTES = 30 * 1024 * 1024;

/** Minimal zip reader: returns the inflated contents of entries whose names match. */
function zipEntries(buf, match) {
  const out = [];
  // End of central directory record.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return out;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!match(name)) continue;
    const lnl = buf.readUInt16LE(local + 26);
    const lel = buf.readUInt16LE(local + 28);
    const start = local + 30 + lnl + lel;
    const data = buf.subarray(start, start + csize);
    try {
      out.push(method === 0 ? data.toString('utf8') : zlib.inflateRawSync(data).toString('utf8'));
    } catch {}
  }
  return out;
}

function textOf(file, ext) {
  const st = fs.statSync(file);
  if (st.size > MAX_BYTES) return '';
  const buf = fs.readFileSync(file);
  if (TEXT_EXT.has(ext)) {
    const s = buf.toString('utf8');
    return ext === 'html' || ext === 'htm' || ext === 'xml' ? s.replace(/<[^>]+>/g, ' ') : ext === 'rtf' ? s.replace(/\\[a-z]+-?\d* ?|[{}]/gi, ' ') : s;
  }
  const want =
    ext === 'docx'
      ? (n) => n === 'word/document.xml' || /^word\/(header|footer|footnotes)\d*\.xml$/.test(n)
      : ext === 'xlsx'
        ? (n) => n === 'xl/sharedStrings.xml'
        : ext === 'pptx'
          ? (n) => /^ppt\/(slides\/slide|notesSlides\/notesSlide)\d+\.xml$/.test(n)
          : (n) => n === 'content.xml';
  return zipEntries(buf, want)
    .join(' ')
    .replace(/<\/(w:p|a:p|text:p|si)>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Candidate files under a folder that are actually on this PC (one PowerShell call per folder). */
const listCache = new Map();
function localFiles(root) {
  const hit = listCache.get(root);
  if (hit && Date.now() - hit.at < 120e3) return Promise.resolve(hit.files);
  const exts = [...TEXT_EXT, ...ZIP_EXT].map((e) => `'.${e}'`).join(',');
  // Walk folders ourselves so big tool folders (node_modules, .git…) are skipped, not scanned.
  // 0x441000 = online-only / offline attributes; 0x2 = hidden; 0x400 = reparse point (links).
  const script = [
    `$e = @(${exts}); $skip = @('node_modules','appdata','$recycle.bin','system volume information','dist','release'); $global:n = 0`,
    `function W($d, $depth) {`,
    `  if ($depth -gt 10 -or $global:n -ge 6000) { return }`,
    `  try { foreach ($f in [IO.Directory]::EnumerateFiles($d)) { if ($e -contains [IO.Path]::GetExtension($f).ToLower()) { if ((([int][IO.File]::GetAttributes($f)) -band 0x441000) -eq 0) { $f; $global:n++ } } } } catch {}`,
    `  try { foreach ($s in [IO.Directory]::EnumerateDirectories($d)) { $nm = [IO.Path]::GetFileName($s).ToLower(); $a = [int][IO.File]::GetAttributes($s); if (-not $nm.StartsWith('.') -and $skip -notcontains $nm -and ($a -band 0x402) -eq 0) { W $s ($depth + 1) } } } catch {}`,
    `}`,
    `W $args[0] 0`
  ].join('\n');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `& { ${script} } '${root.replace(/'/g, "''")}'`], { windowsHide: true, timeout: 20000, maxBuffer: 32 << 20 }, (err, out) => {
      const files = String(out || '')
        .split(/\r?\n/)
        .map((l) => l.split('|')[0])
        .filter(Boolean);
      listCache.set(root, { at: Date.now(), files });
      resolve(files);
    });
  });
}

const textCache = new Map(); // path → { mtime, text }

async function search(query, roots) {
  const q = String(query || '').trim().toLowerCase();
  if (q.length < 2) return [];
  const words = q.split(/\s+/).filter(Boolean);
  const deadline = Date.now() + 6000;
  const results = [];
  const seen = new Set();
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    const files = process.platform === 'win32' ? await localFiles(root) : [];
    for (const file of files) {
      if (Date.now() > deadline || results.length >= 80) break;
      const key = file.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const ext = path.extname(file).slice(1).toLowerCase();
      let text = '';
      try {
        const mtime = fs.statSync(file).mtimeMs;
        const c = textCache.get(file);
        if (c && c.mtime === mtime) text = c.text;
        else {
          text = textOf(file, ext);
          if (textCache.size > 4000) textCache.clear();
          textCache.set(file, { mtime, text });
        }
      } catch {
        continue;
      }
      const lower = text.toLowerCase();
      const nameHit = words.every((w) => path.basename(file).toLowerCase().includes(w));
      if (!nameHit && !words.every((w) => lower.includes(w))) continue;
      const at = lower.indexOf(words[0]);
      const snippet = at >= 0 ? text.slice(Math.max(0, at - 60), at + 120).replace(/\s+/g, ' ').trim() : '';
      results.push({ path: file, name: path.basename(file), snippet, nameHit });
    }
  }
  return results.sort((a, b) => Number(b.nameHit) - Number(a.nameHit));
}

function register() {
  ipcMain.handle('search:content', (_e, query, roots) => search(query, roots && roots.length ? roots : ['desktop', 'documents', 'downloads'].map((k) => app.getPath(k))));
}

module.exports = { register };
