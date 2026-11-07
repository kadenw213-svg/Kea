// The Encyclopedia's Wikipedia and Wiktionary reads (wikiCore.cjs), answered for the window over IPC.
const { ipcMain, net } = require('electron');
const wiki = require('./wikiCore.cjs');
const { handleApp } = require('./ipcGuard.cjs');

function register() {
  wiki.useFetch((url, opts) => net.fetch(url, opts));
  handleApp(ipcMain, 'lookup:wiktionary', (_e, word) => wiki.wiktionary(word));
  handleApp(ipcMain, 'lookup:about', (_e, list, lang) => wiki.about(list, lang));
  handleApp(ipcMain, 'lookup:meanings', (_e, title, lang) => wiki.meanings(title, lang));
  handleApp(ipcMain, 'lookup:complete', (_e, prefix, lang) => wiki.complete(prefix, lang));
  handleApp(ipcMain, 'lookup:search', (_e, query, lang) => wiki.search(query, lang));
  handleApp(ipcMain, 'lookup:find', (_e, query, lang, limit) => wiki.find(query, lang, limit));
  handleApp(ipcMain, 'lookup:article', (_e, title, lang) => wiki.article(title, lang));
  handleApp(ipcMain, 'lookup:titles', (_e, list, lang) => wiki.titles(list, lang));
}

module.exports = { register };
