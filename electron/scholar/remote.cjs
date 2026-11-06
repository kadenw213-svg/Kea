// Worker mode (KEA_WORKER_JOB set): this copy of Kea runs one shared-Claude job for someone else, on the Hub owner's
// PC, and never touches the class site itself. Every class-site read (Kea's own checks and Claude's tools) goes
// through the Hub's relay to that person's own Kea, which is signed in with their own password and answers with page
// text. Their Kea folder on the Hub is reached through the owner console, only while their job runs.
const fs = require('fs');
const path = require('path');

const JOB = process.env.KEA_WORKER_JOB || '';
const active = () => !!JOB;
const port = () => Number(process.env.KEA_HUB_OWNER_PORT) || 4861;
let keyCache = null;
const key = () => (keyCache ??= fs.readFileSync(process.env.KEA_OWNER_KEY_FILE, 'utf8').trim());
const base = () => `http://127.0.0.1:${port()}/owner/scan/${encodeURIComponent(JOB)}`;

async function owner(method, p, { body, raw } = {}) {
  const r = await fetch(base() + p, {
    method,
    headers: { 'x-kea-owner-key': key(), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : raw,
  });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw Object.assign(new Error(data.error || `Owner console said ${r.status}`), { status: r.status, data });
  }
  return r;
}

/** One relayed call; throws the person's Kea's error. */
async function call(op, args = {}) {
  const a = await (await owner('POST', '/call', { body: { op, args } })).json();
  if (!a.ok) throw new Error(a.error || 'The student’s Kea couldn’t do that.');
  return a.result;
}

/** A fetch through their browser, shaped like the Response browser.cjs's own request() gives. */
async function request(url) {
  const r = await call('request', { url });
  const body = Buffer.from(r.body64 || '', 'base64');
  return {
    status: r.status,
    ok: r.status >= 200 && r.status < 300,
    url: r.url || url,
    headers: new Headers(r.headers || {}),
    text: async () => body.toString('utf8'),
    json: async () => JSON.parse(body.toString('utf8')),
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length),
  };
}
const open = (url, offset = 0) => call('open', { url, offset });
const click = (text, nth = 1) => call('click', { text, nth });
const status = () => call('status');

/** The job's details and what their Kea uploaded (job.json: their class site's address and profile name). */
async function job() {
  const files = await (await owner('GET', '/inbox')).json();
  const f = files.files.find((x) => x.path.endsWith('/job.json'));
  if (!f) throw new Error('The job has no job.json from the student’s Kea.');
  const r = await owner('GET', `/inbox-file?path=${encodeURIComponent(f.path)}`);
  return JSON.parse(await r.text());
}

/** A hubsync client for their Kea folder, through the owner console (same shape as hubsync.httpClient). */
function syncClient() {
  return {
    async list(since) {
      return (await owner('GET', `/kea-files?since=${since || 0}`)).json();
    },
    async get(p) {
      return Buffer.from(await (await owner('GET', `/kea-file?path=${encodeURIComponent(p)}`)).arrayBuffer());
    },
    // The worker is their primary device for this job: its writes win (no version check).
    async put(p, data) {
      return (await owner('PUT', `/kea-file?path=${encodeURIComponent(p)}`, { raw: data })).json();
    },
    async del(p) {
      return (await owner('DELETE', `/kea-file?path=${encodeURIComponent(p)}`)).json();
    },
  };
}

/** The running job as the Hub has it: { job: { kind, course, chapter, detail, target, batchSize }, members }. */
const jobInfo = async () => (await owner('GET', '')).json();
/** The course section's shared material (what the shared Claude made for it): list, read, add. */
const courseFiles = async (prefix = '') => (await (await owner('GET', `/course-files?prefix=${encodeURIComponent(prefix)}`)).json()).files;
const courseFile = async (p) => Buffer.from(await (await owner('GET', `/course-file?path=${encodeURIComponent(p)}`)).arrayBuffer());
const putCourseFile = async (p, data) => (await owner('PUT', `/course-file?path=${encodeURIComponent(p)}`, { raw: data })).json();
const finish = (ok, note) => owner('POST', '/finish', { body: { ok, note: String(note || '').slice(0, 1900) } });
const syncRoot = () => path.join(require('electron').app.getPath('userData'), 'hub-sync');

module.exports = { active, JOB, request, open, click, status, job, jobInfo, courseFiles, courseFile, putCourseFile, syncClient, finish, syncRoot };
