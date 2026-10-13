const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  openDialog: (opts) => ipcRenderer.invoke('dialog:open', opts),
  saveDialog: (opts) => ipcRenderer.invoke('dialog:save', opts),
  readFile: (p) => ipcRenderer.invoke('file:read', p),
  writeFile: (p, data) => ipcRenderer.invoke('file:write', p, data),
  fileExists: (p) => ipcRenderer.invoke('file:exists', p),
  showInFolder: (p) => ipcRenderer.invoke('shell:show-in-folder', p),
  getRecent: () => ipcRenderer.invoke('recent:get'),
  addRecent: (p) => ipcRenderer.invoke('recent:add', p),
  removeRecent: (p) => ipcRenderer.invoke('recent:remove', p),
  clearRecent: () => ipcRenderer.invoke('recent:clear'),
  printHtml: (html) => ipcRenderer.invoke('print:html', html),
  pdfFromHtml: (html, opts) => ipcRenderer.invoke('export:pdf-from-html', html, opts),
  getPendingOpen: () => ipcRenderer.invoke('app:get-pending-open'),
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  onOpenPaths: (cb) => {
    const fn = (_e, paths) => cb(paths);
    ipcRenderer.on('app:open-paths', fn);
    return () => ipcRenderer.removeListener('app:open-paths', fn);
  },
  onBeforeClose: (cb) => {
    const fn = () => cb();
    ipcRenderer.on('app:before-close', fn);
    return () => ipcRenderer.removeListener('app:before-close', fn);
  },
  confirmClose: () => ipcRenderer.send('app:confirm-close'),
  getVersion: () => ipcRenderer.invoke('app:version'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.send('update:install'),
  onUpdateState: (cb) => {
    const fn = (_e, state) => cb(state);
    ipcRenderer.on('update:state', fn);
    return () => ipcRenderer.removeListener('update:state', fn);
  }
});
