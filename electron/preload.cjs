const { contextBridge, ipcRenderer, webUtils, webFrame } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  openDialog: (opts) => ipcRenderer.invoke('dialog:open', opts),
  saveDialog: (opts) => ipcRenderer.invoke('dialog:save', opts),
  readFile: (p) => ipcRenderer.invoke('file:read', p),
  writeFile: (p, data) => ipcRenderer.invoke('file:write', p, data),
  fontFile: (family, bold, italic) => ipcRenderer.invoke('fonts:file', family, bold, italic),
  fileExists: (p) => ipcRenderer.invoke('file:exists', p),
  renameFile: (from, to) => ipcRenderer.invoke('file:rename', from, to),
  showInFolder: (p) => ipcRenderer.invoke('shell:show-in-folder', p),
  getRecent: () => ipcRenderer.invoke('recent:get'),
  addRecent: (p) => ipcRenderer.invoke('recent:add', p),
  removeRecent: (p) => ipcRenderer.invoke('recent:remove', p),
  clearRecent: () => ipcRenderer.invoke('recent:clear'),
  setZoom: (f) => webFrame.setZoomFactor(f),
  setTitleOverlay: (color, symbolColor) => ipcRenderer.send('app:set-title-overlay', color, symbolColor),
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
    verifyHere: () => ipcRenderer.invoke('account:verifyHere'),
    avatar: (clear) => ipcRenderer.invoke('account:avatar', !!clear),
    crop: (c) => ipcRenderer.invoke('account:crop', c)
  },
  hub: {
    status: () => ipcRenderer.invoke('hub:status'),
    terms: () => ipcRenderer.invoke('hub:terms'),
    support: () => ipcRenderer.invoke('hub:support'),
    openSupport: () => ipcRenderer.invoke('hub:openSupport'),
    changes: () => ipcRenderer.invoke('hub:changes'),
    openTerms: (since) => ipcRenderer.invoke('hub:openTerms', { since }),
    register: (a) => ipcRenderer.invoke('hub:register', a),
    login: (a) => ipcRenderer.invoke('hub:login', a),
    accept: (a) => ipcRenderer.invoke('hub:accept', a),
    googleVerify: () => ipcRenderer.invoke('hub:googleVerify'),
    googleSignIn: (a) => ipcRenderer.invoke('hub:googleSignIn', a),
    googleReset: (a) => ipcRenderer.invoke('hub:googleReset', a),
    totpSetup: (a) => ipcRenderer.invoke('hub:totpSetup', a),
    totpEnable: (a) => ipcRenderer.invoke('hub:totpEnable', a),
    totpDisable: (a) => ipcRenderer.invoke('hub:totpDisable', a),
    setName: (name) => ipcRenderer.invoke('hub:setName', { name }),
    changePassword: (a) => ipcRenderer.invoke('hub:changePassword', a),
    sessions: () => ipcRenderer.invoke('hub:sessions'),
    signOutOthers: (a) => ipcRenderer.invoke('hub:signOutOthers', a),
    exportData: () => ipcRenderer.invoke('hub:exportData'),
    deleteAccount: (a) => ipcRenderer.invoke('hub:deleteAccount', a),
    logout: () => ipcRenderer.invoke('hub:logout'),
    syncStatus: () => ipcRenderer.invoke('hub:syncStatus'),
    syncNow: () => ipcRenderer.invoke('hub:syncNow'),
    requestScan: () => ipcRenderer.invoke('hub:requestScan'),
    questionChapters: () => ipcRenderer.invoke('hub:questionChapters'),
    requestQuestions: (a) => ipcRenderer.invoke('hub:requestQuestions', a),
    sectionRequests: () => ipcRenderer.invoke('hub:sectionRequests'),
    sectionDecide: (a) => ipcRenderer.invoke('hub:sectionDecide', a),
    sectionCode: (a) => ipcRenderer.invoke('hub:sectionCode', a),
    birthYear: (birthYear) => ipcRenderer.invoke('hub:birthYear', { birthYear }),
    consent: () => ipcRenderer.invoke('hub:consent'),
    consentRequest: (parentEmail) => ipcRenderer.invoke('hub:consentRequest', { parentEmail }),
    consentGoogle: () => ipcRenderer.invoke('hub:consentGoogle'),
    scanJobs: () => ipcRenderer.invoke('hub:scanJobs'),
    setUrl: (url, confirm) => ipcRenderer.invoke('hub:setUrl', { url, confirm: confirm === true }),
    notifications: () => ipcRenderer.invoke('hub:notifications'),
    notificationsRead: (a) => ipcRenderer.invoke('hub:notificationsRead', a),
    notificationsDelete: (a) => ipcRenderer.invoke('hub:notificationsDelete', a),
    onNotifications: (cb) => {
      const h = (_e, n) => cb(n);
      ipcRenderer.on('hub:notifications', h);
      return () => ipcRenderer.removeListener('hub:notifications', h);
    },
    onOpenAccount: (cb) => {
      const h = () => cb();
      ipcRenderer.on('hub:openAccount', h);
      return () => ipcRenderer.removeListener('hub:openAccount', h);
    },
    setPhone: (a) => ipcRenderer.invoke('hub:setPhone', a)
  },
  // Kea Hub classes (electron/hubClasses.cjs): each call takes one object and resolves to { ok, value } or { ok: false, error }.
  hubClasses: {
    call: (name, arg) => {
      if (!/^[a-zA-Z]+$/.test(String(name))) throw new Error('bad call');
      return ipcRenderer.invoke(`hubc:${name}`, arg || {});
    },
    onChanged: (cb) => {
      const h = () => cb();
      ipcRenderer.on('hubc:changed', h);
      return () => ipcRenderer.removeListener('hubc:changed', h);
    },
    onOpen: (cb) => {
      const h = (_e, classId) => cb(classId);
      ipcRenderer.on('hubc:open', h);
      return () => ipcRenderer.removeListener('hubc:open', h);
    }
  },
  scholar: {
    profiles: () => ipcRenderer.invoke('scholar:profiles'),
    createProfile: (name) => ipcRenderer.invoke('scholar:createProfile', name),
    selectProfile: (id) => ipcRenderer.invoke('scholar:selectProfile', id),
    renameProfile: (id, name) => ipcRenderer.invoke('scholar:renameProfile', id, name),
    status: () => ipcRenderer.invoke('scholar:status'),
    courses: () => ipcRenderer.invoke('scholar:courses'),
    courseImages: () => ipcRenderer.invoke('scholar:courseImages'),
    items: (q) => ipcRenderer.invoke('scholar:items', q),
    course: (id) => ipcRenderer.invoke('scholar:course', id),
    setDone: (id, done) => ipcRenderer.invoke('scholar:setDone', id, done),
    importExisting: (folder) => ipcRenderer.invoke('scholar:importExisting', folder),
    school: () => ipcRenderer.invoke('scholar:school'),
    setSchoolHome: (home, platform) => ipcRenderer.invoke('scholar:setSchoolHome', home, platform),
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
    withdrawn: () => ipcRenderer.invoke('scholar:withdrawn'),
    setWithdrawn: (courseId, on, code) => ipcRenderer.invoke('scholar:setWithdrawn', courseId, on, code),
    withdrawDismiss: (courseId) => ipcRenderer.invoke('scholar:withdrawDismiss', courseId),
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
    curriculum: (code, fresh) => ipcRenderer.invoke('scholar:curriculum', code, !!fresh),
    changes: (opts) => ipcRenderer.invoke('scholar:changes', opts),
    mailList: () => ipcRenderer.invoke('scholar:mailList'),
    mailSync: () => ipcRenderer.invoke('scholar:mailSync'),
    onOpenMail: (cb) => {
      const h = (_e, id, reply) => cb(id, !!reply);
      ipcRenderer.on('scholar:openMail', h);
      return () => ipcRenderer.removeListener('scholar:openMail', h);
    },
    mailRead: (id, refresh) => ipcRenderer.invoke('scholar:mailRead', id, !!refresh),
    mailDraft: (key, draft) => ipcRenderer.invoke('scholar:mailDraft', key, draft),
    mailSend: (msg) => ipcRenderer.invoke('scholar:mailSend', msg),
    resume: (task) => ipcRenderer.invoke('scholar:resume', task),
    studyList: () => ipcRenderer.invoke('scholar:studyList'),
    studyGet: (id) => ipcRenderer.invoke('scholar:studyGet', id),
    studyMake: (req) => ipcRenderer.invoke('scholar:studyMake', req),
    studySaved: (req) => ipcRenderer.invoke('scholar:studySaved', req),
    studyPool: (req) => ipcRenderer.invoke('scholar:studyPool', req),
    studyImage: (rel) => ipcRenderer.invoke('scholar:studyImage', rel),
    studyStepsFor: (k) => ipcRenderer.invoke('scholar:studyStepsFor', k),
    teach: (id, req) => ipcRenderer.invoke('scholar:teach', id, req),
    teachStop: (id) => ipcRenderer.invoke('scholar:teachStop', id),
    lessons: (k) => ipcRenderer.invoke('scholar:lessons', k),
    guides: () => ipcRenderer.invoke('scholar:guides'),
    assignments: () => ipcRenderer.invoke('scholar:assignments'),
    classSearch: (q, course) => ipcRenderer.invoke('scholar:classSearch', q, course),
    classRead: (ref) => ipcRenderer.invoke('scholar:classRead', ref),
    lookup: (req) => ipcRenderer.invoke('scholar:lookup', req),
    lookupWait: (id, ms) => ipcRenderer.invoke('scholar:lookupWait', id, ms),
    assignmentBrief: (id) => ipcRenderer.invoke('scholar:assignmentBrief', id),
    guideRescan: (id, code) => ipcRenderer.invoke('scholar:guideRescan', id, code),
    onTeach: (cb) => {
      const h = (_e, m) => cb(m);
      ipcRenderer.on('scholar:teach-event', h);
      return () => ipcRenderer.removeListener('scholar:teach-event', h);
    },
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
  // The video editor: stream big media files from disk, and write exports as they're rendered (electron/media.cjs).
  video: {
    mediaUrl: (p) => ipcRenderer.sendSync('video:media-url', p),
    openWrite: (p) => ipcRenderer.invoke('video:open-write', p),
    writeAt: (id, position, data) => ipcRenderer.invoke('video:write-at', id, position, data),
    closeWrite: (id, abort) => ipcRenderer.invoke('video:close-write', id, abort),
    indexGet: (key) => ipcRenderer.invoke('video:index-get', key),
    indexSet: (key, json) => ipcRenderer.invoke('video:index-set', key, json)
  },
  // On-device AI models (segmentation, …): download/cache/run locally (electron/models.cjs).
  models: {
    state: (type) => ipcRenderer.invoke('models:state', type),
    download: (type, id) => ipcRenderer.invoke('models:download', type, id),
    pause: (type, id) => ipcRenderer.invoke('models:pause', type, id),
    remove: (type, id) => ipcRenderer.invoke('models:delete', type, id),
    onDownload: (cb) => {
      const h = (_e, m) => cb(m);
      ipcRenderer.on('models:download', h);
      return () => ipcRenderer.removeListener('models:download', h);
    }
  },
  // The Kea engine (electron/engine.cjs): native GPU/CPU compute in a utility process.
  engine: {
    status: () => ipcRenderer.invoke('engine:status'),
    resetGpu: () => ipcRenderer.invoke('engine:resetGpu'),
    segment: (type, id, rgba, width, height, accel) => ipcRenderer.invoke('engine:segment', type, id, rgba, width, height, accel),
    faces: (id, rgba, width, height, accel) => ipcRenderer.invoke('engine:faces', id, rgba, width, height, accel),
    transcribe: (repo, audio, englishOnly, timestamps) => ipcRenderer.invoke('engine:transcribe', repo, audio, englishOnly, timestamps)
  },
  // The MCP control server (electron/mcp): the main process asks the renderer to run an editor tool or read editor
  // state for a connected outside app, and the renderer answers on the same call id. Plus the Settings "Connect an
  // app" surface (turn the server on, mint/revoke per-app tokens) and an activity feed for the "controlling Kea" chip.
  control: {
    onRequest: (cb) => {
      const h = (_e, req) => cb(req);
      ipcRenderer.on('kea-control:req', h);
      return () => ipcRenderer.removeListener('kea-control:req', h);
    },
    respond: (callId, result) => ipcRenderer.send('kea-control:res', { callId, ...result }),
    status: () => ipcRenderer.invoke('control:status'),
    setEnabled: (on) => ipcRenderer.invoke('control:set-enabled', on),
    addClient: (name) => ipcRenderer.invoke('control:add-client', name),
    revokeClient: (id) => ipcRenderer.invoke('control:revoke-client', id),
    onActivity: (cb) => {
      const h = (_e, ev) => cb(ev);
      ipcRenderer.on('control:activity', h);
      return () => ipcRenderer.removeListener('control:activity', h);
    }
  },
  assistant: {
    status: () => ipcRenderer.invoke('assistant:status'),
    setKey: (key) => ipcRenderer.invoke('assistant:set-key', key),
    send: (id, req) => ipcRenderer.invoke('assistant:send', id, req),
    stop: (id) => ipcRenderer.invoke('assistant:stop', id),
    capture: (rect) => ipcRenderer.invoke('assistant:capture', rect),
    onEvent: (cb) => {
      const h = (_e, ev) => cb(ev);
      ipcRenderer.on('assistant:event', h);
      return () => ipcRenderer.removeListener('assistant:event', h);
    },
    // On the student's Claude plan (Claude Code) instead of an API key.
    planStatus: () => ipcRenderer.invoke('assistant:plan-status'),
    planSignIn: () => ipcRenderer.invoke('assistant:plan-signin'),
    planSend: (id, req) => ipcRenderer.invoke('assistant:plan-send', id, req),
    planStop: (id) => ipcRenderer.invoke('assistant:plan-stop', id),
    planUsage: () => ipcRenderer.invoke('assistant:plan-usage-get'),
    planUsageRefresh: () => ipcRenderer.invoke('assistant:plan-usage-refresh'),
    onPlanEvent: (cb) => {
      const h = (_e, ev) => cb(ev);
      ipcRenderer.on('assistant:plan-event', h);
      return () => ipcRenderer.removeListener('assistant:plan-event', h);
    },
    onPlanUsage: (cb) => {
      const h = (_e, u) => cb(u);
      ipcRenderer.on('assistant:plan-usage', h);
      return () => ipcRenderer.removeListener('assistant:plan-usage', h);
    }
  },
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
  },
  // Kea Cloud: documents in the person's Kea storage (electron/keaCloud.cjs).
  keaCloud: {
    status: () => ipcRenderer.invoke('keaCloud:status'),
    states: (paths) => ipcRenderer.invoke('keaCloud:states', { paths }),
    newPath: (name) => ipcRenderer.invoke('keaCloud:newPath', { name }),
    rename: (path, name) => ipcRenderer.invoke('keaCloud:rename', { path, name }),
    remove: (path) => ipcRenderer.invoke('keaCloud:remove', { path }),
    newFolder: (parent, name) => ipcRenderer.invoke('keaCloud:newFolder', { parent, name }),
    syncNow: () => ipcRenderer.invoke('keaCloud:syncNow'),
    open: () => ipcRenderer.invoke('keaCloud:open')
  },
  // Work mode: organizations on the Kea Hub (electron/hubOrg.cjs).
  hubOrg: {
    call: (method, path, body) => ipcRenderer.invoke('hubOrg:call', { method, path, body }),
    saveCsv: (orgId, formId, format) => ipcRenderer.invoke('hubOrg:saveCsv', { orgId, formId, format }),
    events: (from, to) => ipcRenderer.invoke('hubOrg:events', { from, to }),
    saveIcs: (from, to) => ipcRenderer.invoke('hubOrg:saveIcs', { from, to }),
    showFile: (file) => ipcRenderer.invoke('hubOrg:showFile', { file })
  }
});
