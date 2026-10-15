// Quiz progress per file: a small JSON record (the reading's concept list and which concepts were missed).
// Stored in <userData>/study/, one file per document. No question transcripts.
const { app, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dir = () => path.join(app.getPath('userData'), 'study');
const fileFor = (key) => path.join(dir(), crypto.createHash('sha1').update(String(key)).digest('hex') + '.json');

function register() {
  ipcMain.handle('study:get', (_e, key) => {
    try {
      return JSON.parse(fs.readFileSync(fileFor(key), 'utf8'));
    } catch {
      return null;
    }
  });
  ipcMain.handle('study:save', (_e, key, data) => {
    fs.mkdirSync(dir(), { recursive: true });
    const f = fileFor(key);
    fs.writeFileSync(f + '.tmp', JSON.stringify(data));
    fs.renameSync(f + '.tmp', f);
    return true;
  });
  ipcMain.handle('study:reset', (_e, key) => {
    fs.rmSync(fileFor(key), { force: true });
    return true;
  });
}

module.exports = { register };
