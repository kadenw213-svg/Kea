// What Kea's class-site window lets pages do: which permissions a site gets, where the window may go, and which
// sign-in pages Kea may save a login from. Plain rules with no Electron in them, so they can be tested on their own
// (test/sitepolicy). browser.cjs applies them.
//
// A school's own domain is its registrable domain from the Public Suffix List (tldts, which the ad blocker already
// ships), so "d2l.ox.ac.uk" belongs to "ox.ac.uk" and never to all of "ac.uk". A class site hosted on a platform
// every school shares (yourschool.instructure.com) has only its own host: the platform's other schools aren't it.
const { getDomain } = require('tldts-experimental');

const hostOf = (u) => {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return '';
  }
};
const isIp = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':');

/** The registrable domain of a host ("learn.colostate.edu" → "colostate.edu"), or '' when it has none. */
function registrableDomain(host) {
  host = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!host || isIp(host)) return '';
  return getDomain(host, { allowPrivateDomains: true }) || '';
}

// Platforms that host many schools under one domain: there, a school is only its own host.
const SHARED = new Set(['instructure.com', 'brightspace.com', 'd2l.com', 'desire2learn.com', 'blackboard.com', 'moodlecloud.com', 'schoology.com', 'google.com', 'microsoft.com', 'microsoftonline.com', 'okta.com', 'onelogin.com']);

/** The school's own domain, from the class site's host: its registrable domain, or the host itself on a shared platform. */
function schoolDomain(homeHost) {
  const host = String(homeHost || '').toLowerCase();
  if (!host) return '';
  const d = registrableDomain(host);
  if (!d || SHARED.has(d)) return host;
  return d;
}
/** Whether a host is the school's (its domain or a host under it). */
function inSchoolDomain(host, homeHost) {
  const d = schoolDomain(homeHost);
  host = String(host || '').toLowerCase();
  return !!d && !!host && (host === d || host.endsWith(`.${d}`));
}

// Sign-in services schools use for single sign-on (the same list as the phone's ClassSite.mayFill).
const IDENTITY_PROVIDERS = /^(login\.microsoftonline\.com|login\.live\.com|accounts\.google\.com)$|\.(okta\.com|onelogin\.com|duosecurity\.com)$/i;
const knownIdentityProvider = (host) => IDENTITY_PROVIDERS.test(String(host || ''));
// Services where anyone can make a tenant of their own (evil.okta.com), so being on one says nothing about the school.
const SIGN_IN_TENANTS = /\.(okta\.com|onelogin\.com|duosecurity\.com)$/i;

/**
 * Whether Kea may save a login submitted on this page (the same rule as the phone's ClassSite.mayFill): https only;
 * once the school's sign-in host is known, that host or the class site itself; before then, the school's own domain, a
 * shared sign-in service, or, only when Kea reached the page from the school's own pages while signing in (`fromHome`),
 * the school's tenant on Okta, OneLogin or Duo.
 */
function mayRememberLogin(url, { home = '', schoolLoginHost = '', fromHome = false } = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  const homeHost = hostOf(home);
  if (!homeHost) return false;
  if (host === homeHost) return true;
  const saved = String(schoolLoginHost || '').toLowerCase().replace(/:\d+$/, '');
  if (saved) return host === saved;
  if (inSchoolDomain(host, homeHost)) return true;
  if (SIGN_IN_TENANTS.test(host)) return fromHome === true;
  return knownIdentityProvider(host);
}

// Course, publisher, video and proctoring platforms a class sends students to (the same family as the MCP's list in
// mcp.cjs, plus the proctoring and live-class tools).
const SCHOOL_PLATFORMS = /(^|\.)(aleks\.com|mheducation\.com|mcgraw-hill\.com|pearson\.com|pearsoned\.com|pearsoncmg\.com|mylabmastering\.com|masteringchemistry\.com|cengage\.com|webassign\.net|cengagenow\.com|holscience\.com|scienceinteractive\.com|macmillanlearning\.com|wiley\.com|wileyplus\.com|zybooks\.com|perusall\.com|instructure\.com|brightspace\.com|d2l\.com|desire2learn\.com|openstax\.org|libretexts\.org|simplesyllabus\.com|kaltura\.com|panopto\.com|youtube\.com|youtube-nocookie\.com|vimeo\.com|turnitin\.com|labster\.com|knewton\.com|hawkeslearning\.com|yuja\.com|readspeaker\.com|respondus\.com|proctorio\.com|honorlock\.com|proctoru\.com|examity\.com|meazurelearning\.com|proctortrack\.com|examsoft\.com|bbcollab\.com|blackboard\.com|zoom\.us|webex\.com|teams\.microsoft\.com|flipgrid\.com|flip\.com|voicethread\.com|vidgrid\.com|screencast-o-matic\.com|loom\.com)$/i;

// Online proctoring services that check the student's camera, microphone or screen in the page itself: Respondus
// Monitor (respondus.com, respondus2.com), Honorlock, Proctorio (proctorio.com/.net, getproctorio.com), ProctorU,
// Examity, Meazure Learning and Proctortrack (verificient.com).
const PROCTORING = /(^|\.)(respondus\.com|respondus2\.com|honorlock\.com|proctorio\.com|proctorio\.net|getproctorio\.com|proctoru\.com|examity\.com|meazurelearning\.com|proctortrack\.com|verificient\.com)$/i;

// Video assignment and live-class tools: students record or join a class on these, so they may ask for the camera and
// microphone. They never get to ask for the screen.
const RECORDING = /(^|\.)(voicethread\.com|flipgrid\.com|flip\.com|kaltura\.com|yuja\.com|zoom\.us)$/i;

// Camera and microphone, and the screen: only the class site, the school's sign-in host and a proctoring service
// may ask (and, for the camera and microphone, a video tool above), and the student is asked once per site.
const ASKED = { media: 'media', 'display-capture': 'screen' };
// What school platforms get without asking: what course work needs (full screen for a quiz, a video's keys, storage).
// Never: reading the clipboard, the file system, idle detection, or opening other programs (openExternal).
const PLATFORM_PERMISSIONS = new Set(['fullscreen', 'pointerLock', 'keyboardLock', 'mediaKeySystem', 'storage-access', 'top-level-storage-access', 'window-management', 'speaker-selection', 'persistent-storage']);
// Allowed anywhere: a page copying text the student asked it to copy.
const ANY_PERMISSIONS = new Set(['clipboard-sanitized-write']);

/** A school platform that gets PLATFORM_PERMISSIONS: the class site, the school's domain, its sign-in, known platforms. */
function trustedHost(host, { home = '', sso = '' } = {}) {
  host = String(host || '').toLowerCase();
  if (!host) return false;
  const homeHost = hostOf(home);
  if (homeHost && (host === homeHost || inSchoolDomain(host, homeHost))) return true;
  if (sso && host === String(sso).toLowerCase().replace(/:\d+$/, '')) return true;
  return SCHOOL_PLATFORMS.test(host);
}
/** May this host ask for the camera, microphone or screen at all (the student still answers)? */
function mediaHost(host, { home = '', sso = '' } = {}) {
  host = String(host || '').toLowerCase();
  if (!host) return false;
  const homeHost = hostOf(home);
  if (homeHost && host === homeHost) return true;
  if (sso && host === String(sso).toLowerCase().replace(/:\d+$/, '')) return true;
  return PROCTORING.test(host);
}

/**
 * What to do with a permission a page asks for: 'allow', 'deny', or { ask: 'media' | 'screen', origin } (allowed only
 * if the student says so; their answer is kept per origin and kind).
 */
function decide(permission, url, ctx = {}) {
  if (ANY_PERMISSIONS.has(permission)) return 'allow';
  let u;
  try {
    u = new URL(url);
  } catch {
    return 'deny';
  }
  if (u.protocol !== 'https:') return 'deny';
  const host = u.hostname.toLowerCase();
  if (ASKED[permission]) return mediaHost(host, ctx) || (permission === 'media' && RECORDING.test(host)) ? { ask: ASKED[permission], origin: u.origin } : 'deny';
  if (!PLATFORM_PERMISSIONS.has(permission)) return 'deny';
  return trustedHost(host, ctx) ? 'allow' : 'deny';
}

/**
 * Where the class-site window may go: 'load' (http and https, in the window), 'confirm' (a mailto: or https link to
 * open outside Kea, after the student says so), or 'deny' (every other scheme: file:, javascript:, Windows protocol
 * handlers such as ms-msdt: or search-ms:).
 */
function navigation(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return 'deny';
  }
  if (u.protocol === 'https:' || u.protocol === 'http:') return 'load';
  if (u.protocol === 'mailto:') return 'confirm';
  return 'deny';
}
/** Whether a link may be opened outside Kea after the student confirms: https (in their browser) and mailto only. */
const externalAllowed = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'mailto:';
  } catch {
    return false;
  }
};

module.exports = { registrableDomain, schoolDomain, inSchoolDomain, knownIdentityProvider, mayRememberLogin, SCHOOL_PLATFORMS, PROCTORING, PLATFORM_PERMISSIONS, trustedHost, mediaHost, decide, navigation, externalAllowed, hostOf };
