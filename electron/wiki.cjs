// The Encyclopedia's Wikipedia and Wiktionary reads (wikiCore.cjs), answered for the window over IPC.
const { ipcMain, net } = require('electron');
const wiki = require('./wikiCore.cjs');

function register() {
  wiki.useFetch((url, opts) => net.fetch(url, opts));
  ipcMain.handle('lookup:wiktionary', (_e, word) => wiki.wiktionary(word));
  ipcMain.handle('lookup:about', (_e, list, lang) => wiki.about(list, lang));
  ipcMain.handle('lookup:meanings', (_e, title, lang) => wiki.meanings(title, lang));
  ipcMain.handle('lookup:complete', (_e, prefix, lang) => wiki.complete(prefix, lang));
  ipcMain.handle('lookup:search', (_e, query, lang) => wiki.search(query, lang));
  ipcMain.handle('lookup:find', (_e, query, lang, limit) => wiki.find(query, lang, limit));
  ipcMain.handle('lookup:article', (_e, title, lang) => wiki.article(title, lang));
  ipcMain.handle('lookup:titles', (_e, list, lang) => wiki.titles(list, lang));
}

module.exports = { register };
