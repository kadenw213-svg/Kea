const { contextBridge, ipcRenderer, webUtils, webFrame } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  openDialog: (opts) => ipcRenderer.invoke('dialog:open', opts),
  saveDialog: (opts) => ipcRenderer.invoke('dialog:save', opts),
  readFile: (p) => ipcRenderer.invoke('file:read', p),
  writeFile: (p, data) => ipcRenderer.invoke('file:write', p, data),
  fileExists: (p) => ipcRenderer.invoke('file:exists', p),
  renameFile: (from, to) => ipcRenderer.invoke('file:rename', from, to),
  showInFolder: (p) => ipcRenderer.invoke('shell:show-in-folder', p),
  getRecent: () => ipcRenderer.invoke('recent:get'),
  addRecent: (p) => ipcRenderer.invoke('recent:add', p),
  removeRecent: (p) => ipcRenderer.invoke('recent:remove', p),
  clearRecent: () => ipcRenderer.invoke('recent:clear'),
  setZoom: (f) => webFrame.setZoomFactor(f),
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    onChange: (cb) => {
      const fn = (_e, all) => cb(all);
      ipcRenderer.on('settings:changed', fn);
      return () => ipcRenderer.removeListener('settings:changed', fn);
    }
  },
  history: {
    list: (p) => ipcRenderer.invoke('history:list', p),
    read: (p, id) => ipcRenderer.invoke('history:read', p, id),
    snapshot: (p, label) => ipcRenderer.invoke('history:snapshot', p, label),
    label: (p, id, label) => ipcRenderer.invoke('history:label', p, id, label),
    remove: (p, id) => ipcRenderer.invoke('history:delete', p, id),
    usage: () => ipcRenderer.invoke('history:usage'),
    clear: () => ipcRenderer.invoke('history:clear'),
    openFolder: () => ipcRenderer.invoke('history:open-folder')
  },
  present: {
    screens: () => ipcRenderer.invoke('present:screens'),
    open: (html, start) => ipcRenderer.invoke('present:open', html, start),
    goto: (i, type, dur, dir) => ipcRenderer.invoke('present:goto', i, type, dur, dir),
    close: () => ipcRenderer.invoke('present:close'),
    onClosed: (cb) => {
      const fn = () => cb();
      ipcRenderer.on('present:closed', fn);
      return () => ipcRenderer.removeListener('present:closed', fn);
    }
  },
  account: {
    get: () => ipcRenderer.invoke('account:get'),
    suggest: () => ipcRenderer.invoke('account:suggest'),
    save: (a) => ipcRenderer.invoke('account:save', a),
    verify: () => ipcRenderer.invoke('account:verify'),
    avatar: (clear) => ipcRenderer.invoke('account:avatar', !!clear),
    crop: (c) => ipcRenderer.invoke('account:crop', c),
    signOut: () => ipcRenderer.invoke('account:signOut')
  },
  scholar: {
    profiles: () => ipcRenderer.invoke('scholar:profiles'),
    createProfile: (name) => ipcRenderer.invoke('scholar:createProfile', name),
    selectProfile: (id) => ipcRenderer.invoke('scholar:selectProfile', id),
    renameProfile: (id, name) => ipcRenderer.invoke('scholar:renameProfile', id, name),
    status: () => ipcRenderer.invoke('scholar:status'),
    courses: () => ipcRenderer.invoke('scholar:courses'),
    items: (q) => ipcRenderer.invoke('scholar:items', q),
    course: (id) => ipcRenderer.invoke('scholar:course', id),
    setDone: (id, done) => ipcRenderer.invoke('scholar:setDone', id, done),
    importExisting: (folder) => ipcRenderer.invoke('scholar:importExisting', folder),
    school: () => ipcRenderer.invoke('scholar:school'),
    setSchoolHome: (home) => ipcRenderer.invoke('scholar:setSchoolHome', home),
    signIn: (remember) => ipcRenderer.invoke('scholar:signIn', remember),
    forgetLogin: () => ipcRenderer.invoke('scholar:forgetLogin'),
    siteStatus: () => ipcRenderer.invoke('scholar:siteStatus'),
    check: () => ipcRenderer.invoke('scholar:check'),
    installUv: () => ipcRenderer.invoke('scholar:installUv'),
    installClaude: () => ipcRenderer.invoke('scholar:installClaude'),
    signInClaude: () => ipcRenderer.invoke('scholar:signInClaude'),
    setupEngine: () => ipcRenderer.invoke('scholar:setupEngine'),
    run: (task, arg) => ipcRenderer.invoke('scholar:run', task, arg),
    devices: () => ipcRenderer.invoke('scholar:devices'),
    devicesFind: () => ipcRenderer.invoke('scholar:devicesFind'),
    devicesJoin: (choice) => ipcRenderer.invoke('scholar:devicesJoin', choice),
    makePrimary: (id) => ipcRenderer.invoke('scholar:makePrimary', id),
    setDrive: (choice) => ipcRenderer.invoke('scholar:setDrive', choice),
    stop: () => ipcRenderer.invoke('scholar:stop'),
    runStatus: () => ipcRenderer.invoke('scholar:runStatus'),
    activity: () => ipcRenderer.invoke('scholar:activity'),
    news: () => ipcRenderer.invoke('scholar:news'),
    markNewsRead: (ids) => ipcRenderer.invoke('scholar:markNewsRead', ids),
    pending: () => ipcRenderer.invoke('scholar:pending'),
    inbox: () => ipcRenderer.invoke('scholar:inbox'),
    markInboxRead: (ids) => ipcRenderer.invoke('scholar:markInboxRead', ids),
    deleteInbox: (ids) => ipcRenderer.invoke('scholar:deleteInbox', ids),
    checkInbox: () => ipcRenderer.invoke('scholar:checkInbox'),
    grades: (courseId, code) => ipcRenderer.invoke('scholar:grades', courseId, code),
    handInTargets: () => ipcRenderer.invoke('scholar:handInTargets'),
    cloudDrives: () => ipcRenderer.invoke('scholar:cloudDrives'),
    syncNow: () => ipcRenderer.invoke('scholar:syncNow'),
    handIn: (ou, folderId, file) => ipcRenderer.invoke('scholar:handIn', ou, folderId, file),
    openLink: (url) => ipcRenderer.invoke('scholar:openLink', url),
    replyMessage: (url, course) => ipcRenderer.invoke('scholar:replyMessage', url, course),
    itemHistory: (id) => ipcRenderer.invoke('scholar:itemHistory', id),
    courseRules: (code) => ipcRenderer.invoke('scholar:courseRules', code),
    changes: (opts) => ipcRenderer.invoke('scholar:changes', opts),
    mailList: () => ipcRenderer.invoke('scholar:mailList'),
    mailRead: (id, refresh) => ipcRenderer.invoke('scholar:mailRead', id, !!refresh),
    mailDraft: (key, draft) => ipcRenderer.invoke('scholar:mailDraft', key, draft),
    mailSend: (msg) => ipcRenderer.invoke('scholar:mailSend', msg),
    resume: (task) => ipcRenderer.invoke('scholar:resume', task),
    studyList: () => ipcRenderer.invoke('scholar:studyList'),
    studyGet: (id) => ipcRenderer.invoke('scholar:studyGet', id),
    studyMake: (req) => ipcRenderer.invoke('scholar:studyMake', req),
    studySaved: (req) => ipcRenderer.invoke('scholar:studySaved', req),
    textbookOf: (file) => ipcRenderer.invoke('scholar:textbookOf', file),
    studyBanks: () => ipcRenderer.invoke('scholar:studyBanks'),
    studyDelete: (id) => ipcRenderer.invoke('scholar:studyDelete', id),
    studyAttempt: (id, a) => ipcRenderer.invoke('scholar:studyAttempt', id, a),
    studyKnown: (id, known) => ipcRenderer.invoke('scholar:studyKnown', id, known),
    studySaveMine: (set) => ipcRenderer.invoke('scholar:studySaveMine', set),
    studyStar: (k, on) => ipcRenderer.invoke('scholar:studyStar', k, on),
    studyLearn: (id, levels) => ipcRenderer.invoke('scholar:studyLearn', id, levels),
    studyMatch: (id, ms) => ipcRenderer.invoke('scholar:studyMatch', id, ms),
    studyReview: (opts) => ipcRenderer.invoke('scholar:studyReview', opts),
    studyReviewMark: (k, grade, ctx) => ipcRenderer.invoke('scholar:studyReviewMark', k, grade, ctx),
    onResume: (cb) => {
      const h = (_e, p) => cb(p);
      ipcRenderer.on('scholar:resume', h);
      return () => ipcRenderer.removeListener('scholar:resume', h);
    },
    onRun: (cb) => {
      const h = (_e, r) => cb(r);
      ipcRenderer.on('scholar:run', h);
      return () => ipcRenderer.removeListener('scholar:run', h);
    },
    onNews: (cb) => {
      const h = (_e, n) => cb(n);
      ipcRenderer.on('scholar:news', h);
      return () => ipcRenderer.removeListener('scholar:news', h);
    },
    onSetupLine: (cb) => {
      const h = (_e, l) => cb(l);
      ipcRenderer.on('scholar:setupLine', h);
      return () => ipcRenderer.removeListener('scholar:setupLine', h);
    },
    onChanged: (cb) => {
      const h = () => cb();
      ipcRenderer.on('scholar:changed', h);
      return () => ipcRenderer.removeListener('scholar:changed', h);
    }
  },
  lookup: {
    search: (query, lang) => ipcRenderer.invoke('lookup:search', query, lang),
    find: (query, lang, limit) => ipcRenderer.invoke('lookup:find', query, lang, limit),
    article: (title, lang) => ipcRenderer.invoke('lookup:article', title, lang),
    titles: (list, lang) => ipcRenderer.invoke('lookup:titles', list, lang),
    complete: (prefix, lang) => ipcRenderer.invoke('lookup:complete', prefix, lang),
    about: (list, lang) => ipcRenderer.invoke('lookup:about', list, lang),
    meanings: (title, lang) => ipcRenderer.invoke('lookup:meanings', title, lang),
    define: (word, maxSenses) => ipcRenderer.invoke('lookup:define', word, maxSenses),
    wiktionary: (word) => ipcRenderer.invoke('lookup:wiktionary', word)
  },
  speech: {
    state: () => ipcRenderer.invoke('speech:state'),
    download: (id) => ipcRenderer.invoke('speech:download', id),
    pause: (id) => ipcRenderer.invoke('speech:pause', id),
    remove: (id) => ipcRenderer.invoke('speech:delete', id),
    onDownload: (cb) => {
      const fn = (_e, m) => cb(m);
      ipcRenderer.on('speech:download', fn);
      return () => ipcRenderer.removeListener('speech:download', fn);
    }
  },
  tts: {
    voices: () => ipcRenderer.invoke('tts:voices'),
    speak: (text, voice, rate) => ipcRenderer.invoke('tts:speak', text, voice, rate),
    stop: () => ipcRenderer.invoke('tts:stop')
  },
  searchContent: (q, roots) => ipcRenderer.invoke('search:content', q, roots),
  citeLookup: (q) => ipcRenderer.invoke('cite:lookup', q),
  google: {
    status: () => ipcRenderer.invoke('google:status'),
    signIn: () => ipcRenderer.invoke('google:sign-in'),
    signOut: () => ipcRenderer.invoke('google:sign-out'),
    open: (p) => ipcRenderer.invoke('google:open', p),
    save: (id, ext, data) => ipcRenderer.invoke('google:save', id, ext, data)
  },
  recovery: {
    put: (meta, data) => ipcRenderer.invoke('recovery:put', meta, data),
    drop: (tabId) => ipcRenderer.invoke('recovery:drop', tabId),
    list: () => ipcRenderer.invoke('recovery:list'),
    read: (tabId) => ipcRenderer.invoke('recovery:read', tabId)
  },
  listDir: (dir, opts) => ipcRenderer.invoke('fs:list', dir, opts),
  searchDir: (dir, q, opts) => ipcRenderer.invoke('fs:search', dir, q, opts),
  statMany: (paths) => ipcRenderer.invoke('fs:stat-many', paths),
  knownFolders: () => ipcRenderer.invoke('fs:known-folders'),
  openFolderDialog: () => ipcRenderer.invoke('dialog:open-folder'),
  isDir: (p) => ipcRenderer.invoke('fs:is-dir', p),
  openPath: (p) => ipcRenderer.invoke('shell:open-path', p),
  clearPreviews: () => ipcRenderer.invoke('preview:clear'),
  clearMeta: () => ipcRenderer.invoke('meta:clear'),
  openDataFolder: () => ipcRenderer.invoke('app:open-data-folder'),
  sysinfo: () => ipcRenderer.invoke('app:sysinfo'),
  getPreview: (p) => ipcRenderer.invoke('preview:get', p),
  setPreview: (p, preview) => ipcRenderer.invoke('preview:set', p, preview),
  getMeta: () => ipcRenderer.invoke('meta:all'),
  setMeta: (p, patch) => ipcRenderer.invoke('meta:set', p, patch),
  homeSettings: () => ipcRenderer.invoke('home:settings'),
  setHomeSettings: (patch) => ipcRenderer.invoke('home:set-settings', patch),
  detectDrives: () => ipcRenderer.invoke('drives:detect'),
  connectDrive: (id) => ipcRenderer.invoke('drives:connect', id),
  onDriveProgress: (cb) => {
    const fn = (_e, m) => cb(m);
    ipcRenderer.on('drives:progress', fn);
    return () => ipcRenderer.removeListener('drives:progress', fn);
  },
  printHtml: (html, opts) => ipcRenderer.invoke('print:html', html, opts),
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
  ai: {
    state: () => ipcRenderer.invoke('ai:state'),
    setSettings: (patch) => ipcRenderer.invoke('ai:set-settings', patch),
    resetSettings: () => ipcRenderer.invoke('ai:reset-settings'),
    download: (tier) => ipcRenderer.invoke('ai:download', tier),
    pauseDownload: (tier) => ipcRenderer.invoke('ai:pause-download', tier),
    deleteModel: (tier) => ipcRenderer.invoke('ai:delete-model', tier),
    generate: (req) => ipcRenderer.invoke('ai:generate', req),
    stop: (id) => ipcRenderer.invoke('ai:stop', id),
    count: (text) => ipcRenderer.invoke('ai:count', text),
    benchmark: () => ipcRenderer.invoke('ai:benchmark'),
    onEvent: (cb) => {
      const fn = (_e, m) => cb(m);
      ipcRenderer.on('ai:event', fn);
      return () => ipcRenderer.removeListener('ai:event', fn);
    },
    onDownload: (cb) => {
      const fn = (_e, m) => cb(m);
      ipcRenderer.on('ai:download', fn);
      return () => ipcRenderer.removeListener('ai:download', fn);
    }
  },
  onUpdateState: (cb) => {
    const fn = (_e, state) => cb(state);
    ipcRenderer.on('update:state', fn);
    return () => ipcRenderer.removeListener('update:state', fn);
  }
});
