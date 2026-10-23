// Big media files for the video editor, without reading them into memory: a kea-media:// address that streams a file
// with HTTP Range requests (so <video> can seek), and positional writes so an export goes to disk as it's rendered.
// The window asks for an address per file it has opened (a token), so a web page can't use the scheme to read
// arbitrary files.
const { ipcMain, protocol } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

const MIME = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml'
};
const SCHEME = { scheme: 'kea-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } };

const tokens = new Map(); // token → path
const byPath = new Map(); // path → token
const writers = new Map(); // id → { fd, path }

function register() {
  ipcMain.on('video:media-url', (e, p) => {
    const file = path.resolve(String(p || ''));
    let t = byPath.get(file);
    if (!t) {
      t = crypto.randomBytes(12).toString('hex');
      tokens.set(t, file);
      byPath.set(file, t);
    }
    e.returnValue = `kea-media://m/${t}/${encodeURIComponent(path.basename(file))}`;
  });

  protocol.handle('kea-media', async (request) => {
    const url = new URL(request.url);
    const file = tokens.get(url.pathname.split('/')[1] || '');
    // (Kea's page is cross-origin isolated, so its media must say it may be loaded from elsewhere.)
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges', 'Cross-Origin-Resource-Policy': 'cross-origin' };
    if (!file) return new Response('Not found', { status: 404, headers: cors });
    let size;
    try {
      size = (await fs.promises.stat(file)).size;
    } catch {
      return new Response('Not found', { status: 404, headers: cors });
    }
    const type = MIME[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream';
    const base = { ...cors, 'Content-Type': type, 'Accept-Ranges': 'bytes' };
    const m = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') || '');
    if (!m) return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers: { ...base, 'Content-Length': String(size) } });
    let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    let end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } });
    return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), {
      status: 206,
      headers: { ...base, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) }
    });
  });

  ipcMain.handle('video:open-write', async (_e, p) => {
    const id = crypto.randomBytes(8).toString('hex');
    writers.set(id, { fd: await fs.promises.open(p, 'w'), path: p });
    return id;
  });
  ipcMain.handle('video:write-at', async (_e, id, position, data) => {
    const w = writers.get(id);
    if (!w) throw new Error('That export file is closed.');
    const buf = Buffer.from(data);
    await w.fd.write(buf, 0, buf.length, position);
  });
  ipcMain.handle('video:close-write', async (_e, id, abort) => {
    const w = writers.get(id);
    if (!w) return;
    writers.delete(id);
    await w.fd.close();
    if (abort) await fs.promises.rm(w.path, { force: true });
  });

  // Media-index cache: the per-clip transcript/scenes/silences/contact-sheet, keyed by "path|size|mtime" so it's
  // rebuilt only when the file changes. Lives in userData so it's never synced with the project.
  const indexDir = () => path.join(require('electron').app.getPath('userData'), 'cache', 'video-index');
  const indexPath = (key) => path.join(indexDir(), crypto.createHash('sha1').update(String(key)).digest('hex') + '.json');
  ipcMain.handle('video:index-get', async (_e, key) => {
    try {
      return await fs.promises.readFile(indexPath(key), 'utf8');
    } catch {
      return null;
    }
  });
  ipcMain.handle('video:index-set', async (_e, key, json) => {
    await fs.promises.mkdir(indexDir(), { recursive: true });
    await fs.promises.writeFile(indexPath(key), String(json));
    return true;
  });
}

module.exports = { register, SCHEME };
