// Runs in Kea's class-site window (not in Kea itself). Two jobs:
//  - when the user signs in and asked Kea to remember it, report the login form they submitted to Kea's main process
//    (which keeps it only in that case, encrypted);
//  - fill in and submit that saved login when Kea signs in for them. Kea sends it here over its private channel, so
//    the web page's own scripts never see it.
const { ipcRenderer } = require('electron');

const visible = (el) => !!el && el.offsetParent !== null && !el.disabled;
const textInputs = (root) => [...root.querySelectorAll('input[type=text], input[type=email], input:not([type])')].filter(visible);

function report(form) {
  // Only while the user is signing in and asked Kea to remember it; otherwise nothing leaves the page.
  if (!form || !form.querySelector || !ipcRenderer.sendSync('class-site:remembering')) return;
  const pw = [...form.querySelectorAll('input[type=password]')].find((x) => x.value);
  const user = textInputs(form).find((x) => x.value);
  // A name-only first step ("Next") is reported too, so a two-step login can be put back together.
  if (!pw && !user) return;
  ipcRenderer.send('class-site:login', { url: location.href, user: user ? user.value : '', pass: pw ? pw.value : '', userField: user ? user.name || user.id : '', passField: pw ? pw.name || pw.id : '' });
}
document.addEventListener('submit', (e) => report(e.target), true);
document.addEventListener(
  'click',
  (e) => {
    const b = e.target && e.target.closest && e.target.closest('button, input[type=submit]');
    if (b && b.form) report(b.form);
  },
  true
);

function setValue(el, v) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
  setter.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
function submit(form, near) {
  const btn = (form || document).querySelector('button[type=submit], input[type=submit], button:not([type])');
  if (btn && visible(btn)) btn.click();
  else if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
  else if (near) near.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

/** Fill in one step of the sign-in page with the saved login. True if something was filled and submitted. */
function fill(login) {
  const byName = (n) => (n ? document.querySelector(`input[name="${CSS.escape(n)}"], #${CSS.escape(n)}`) : null);
  const pw = (visible(byName(login.passField)) && byName(login.passField)) || [...document.querySelectorAll('input[type=password]')].find(visible);
  const user = (visible(byName(login.userField)) && byName(login.userField)) || textInputs(pw && pw.form ? pw.form : document)[0];
  if (pw) {
    if (user && !user.value && login.user) setValue(user, login.user);
    setValue(pw, login.pass);
    submit(pw.form, pw);
    return true;
  }
  if (user && login.user) {
    setValue(user, login.user);
    submit(user.form, user);
    return true;
  }
  // "Stay signed in?" pages.
  const yes = document.querySelector('#idSIButton9, input[type=submit][value="Yes"]');
  if (visible(yes)) {
    yes.click();
    return true;
  }
  return false;
}

ipcRenderer.on('class-site:fill', (_e, login) => ipcRenderer.send('class-site:filled', fill(login)));
