// Who may call Kea's riskiest IPC handlers (files, settings, opening programs, hand-in, Claude runs): only Kea's own
// page, the top frame of a window showing app://kea/ (or the dev server while developing). A frame inside it, or any
// other window (the class-site browser, a print page), is refused.
const DEV_URL = process.env.VITE_DEV_SERVER_URL || '';

/** Whether an IPC event came from Kea's own top-level page. */
function fromApp(e) {
  try {
    const f = e && e.senderFrame;
    if (!f || f.parent) return false;
    const url = String(f.url || '');
    if (url.startsWith('app://kea/')) return true;
    return !!DEV_URL && !require('electron').app.isPackaged && url.startsWith(DEV_URL);
  } catch {
    return false;
  }
}

/** A handler that runs only for Kea's own page; anything else gets an error. */
const appOnly = (handler) =>
  function (e, ...args) {
    if (!fromApp(e)) throw new Error('Not allowed from this page.');
    return handler.call(this, e, ...args);
  };

module.exports = { fromApp, appOnly };
