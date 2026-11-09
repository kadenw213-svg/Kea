// One cell of the shared-Claude compatibility matrix (test/compat/shared-claude.test.mjs), in a child process of its
// own:   node shared-claude-cell.mjs <spec.json> <result.json>
// spec: { keac: { dir, label }, kea: { dir, label, current }, keaDir } — a KeaC and a Kea (the person's PC and the
// owner's worker side), each the working tree or an older release read with git show. Real KeaC on 127.0.0.1 port 0
// with scratch data; a stand-in Google; a stand-in claude (Kea's test/sharedclaude/fake-claude.cjs); fetch fenced to
// loopback. No real Claude runs and nothing leaves this computer.
// The same file is in Kea and KeaC (test/compat/shared-claude-cell.mjs): keep them the same.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Module, { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const [specFile, outFile] = process.argv.slice(2);

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const u = new URL(typeof input === 'string' ? input : input?.url ?? String(input));
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return Promise.reject(new Error(`compat: refused a request off this computer (${u.origin})`));
  return realFetch(input, init);
};

const GOOGLE_CLIENT = 'kea-compat-test.apps.googleusercontent.com';
function fakeGoogle() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'compat-kid', alg: 'RS256', use: 'sig' };
  let n = 0;
  const token = (email) => {
    const t = Math.floor(Date.now() / 1000);
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const h = enc({ alg: 'RS256', kid: 'compat-kid', typ: 'JWT' });
    const b = enc({ iss: 'https://accounts.google.com', aud: GOOGLE_CLIENT, sub: `g-${email}`, email, email_verified: true, name: 'Compat Person', iat: t, exp: t + 3600, jti: `c${++n}-${crypto.randomUUID()}`, nonce: crypto.randomUUID() });
    return `${h}.${b}.${crypto.sign('RSA-SHA256', Buffer.from(`${h}.${b}`), privateKey).toString('base64url')}`;
  };
  return { token, keacOptions: { googleClientIds: [GOOGLE_CLIENT], googleKeyFn: async () => [jwk], microsoftClientIds: [], microsoftKeyFn: async () => [] } };
}

const steps = [];
async function step(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    steps.push({ name, ok: true, ms: Date.now() - t0, ...(detail === undefined ? {} : { detail }) });
  } catch (e) {
    steps.push({ name, ok: false, ms: Date.now() - t0, error: String(e?.stack || e?.message || e).slice(0, 2000), data: e?.data ?? null });
  }
}
const check = (cond, msg, data) => {
  if (!cond) throw Object.assign(new Error(msg), { data: data ?? null });
};
const scratch = [];
const mk = (label) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `kea-compat-sc-${label}-`));
  scratch.push(d);
  return d;
};
async function call(base, method, p, { token, body } = {}) {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, body: json ?? text };
}
const ok = (r) => {
  check(r.status >= 200 && r.status < 300, `HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 400)}`, r.body);
  return r.body;
};

/** Kea's main-process modules from `dir`, under Node with an Electron stand-in. */
function loadKea(dir, keacBase) {
  const userData = mk('pc');
  const version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
  const deep = () => new Proxy(function () {}, { get: (t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : deep()), apply: () => deep(), construct: () => deep() });
  const stub = {
    app: { getPath: () => userData, getVersion: () => version, getAppPath: () => dir, isPackaged: false, on() {}, exit() {}, whenReady: () => Promise.resolve(), getName: () => 'Kea' },
    ipcMain: { on() {}, handle() {}, removeHandler() {} },
    BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
    Notification: class { static isSupported() { return false; } show() {} close() {} },
    dialog: deep(), session: deep(), webContents: deep(),
    net: { fetch: (...a) => globalThis.fetch(...a) },
    shell: { openExternal: async () => { throw new Error('compat: no browser'); }, showItemInFolder() {} },
    safeStorage: { isEncryptionAvailable: () => false },
  };
  const id = path.join(userData, 'electron-stub.cjs');
  const m = new Module(id);
  Object.assign(m, { filename: id, loaded: true, exports: stub });
  Module._cache[id] = m;
  const resolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    return request === 'electron' ? id : resolve.call(this, request, ...rest);
  };
  const req = createRequire(path.join(dir, 'electron', 'x.cjs'));
  req('./settings.cjs').set({ 'hub.url': keacBase });
  process.env.KEA_HUB_URL = keacBase;
  const hub = req('./hub.cjs');
  hub._account.setBackground(false);
  hub._account.setLimits({ req: 8000, status: 4000 });
  return { hub, req, userData, version };
}
async function signIn(pc, google, email) {
  pc.hub._account.setIdTokens(async () => google.token(email));
  try {
    await pc.hub._account.oauthSignIn({ provider: 'google' });
  } catch (e) {
    if (!(e.status === 404 && e.data?.needsAccount)) throw e;
  }
  const terms = (await pc.hub.req('GET', '/v1/terms', undefined, { auth: false })).terms;
  const s = await pc.hub._account.continueSignIn({ termsVersion: terms.version, termsSections: terms.sections.map((x) => x.id), age13: true, name: 'Compat PC' });
  check(s.signedIn, `not signed in: ${JSON.stringify({ state: s.state })}`);
  return s;
}

// (Made up here: shaped like a Claude API key, never a real one. An older KeaC ignores the apiKey option.)
const API_KEY = `sk-ant-api03-${'c'.repeat(24)}COMPATONLY`;
const NOT_AVAILABLE = /shared Claude isn’t available right now/;

async function main(spec) {
  const google = fakeGoogle();
  const { createKeaC } = await import(pathToFileURL(path.join(spec.keac.dir, 'server', 'index.mjs')).href);
  const { ownerFetch } = await import(pathToFileURL(path.join(spec.keac.dir, 'server', 'lib', 'ownerauth.mjs')).href);
  let apiKey = API_KEY;
  const keacData = mk('keac');
  const keac = createKeaC({ dataDir: keacData, log: false, minFreeBytes: 0, fileOverheadBytes: 0, ...google.keacOptions, apiKey: () => apiKey });
  const ports = await keac.listen({ port: 0, ownerPort: 0 });
  const base = `http://127.0.0.1:${ports.port}`, ownerBase = `http://127.0.0.1:${ports.ownerPort}`;
  const owner = async (method, p, body) => {
    const r = await ownerFetch(ownerBase, keac.ownerKey, method, p, body);
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const ownerCall = (p, body) => owner('POST', p, body || {}).then((r) => r.body);
  try {
    const features = ok(await call(base, 'GET', '/v1/health')).features || [];
    const sharedTeach = features.includes('sharedTeach');
    const usageTracking = features.includes('usageTracking');
    const apiBackend = features.includes('apiBackend');
    await step('health: shared-Claude features', async () => ({ sharedTeach, usageTracking, apiBackend }));
    // (The steps before the backends' own run on the owner's plan, as they always did; those set what they test.)
    if (apiBackend) ok(await owner('POST', '/owner/settings', { api: { backend: 'plan' } }));

    const pc = loadKea(spec.kea.dir, base);
    await step('Kea signs in to its Kea account', async () => (await signIn(pc, google, 'sc-person@compat.test')).state);
    // (Born in 1990: no parent's sign-off needed for the shared Claude.)
    keac.h.run('UPDATE accounts SET birth_year = 1990');
    const has = (p) => fs.existsSync(path.join(spec.kea.dir, 'electron', p));
    const newKea = has('scholar/usage.cjs');

    // ---- Teach lessons ----
    if (newKea) {
      const teach = pc.req('./scholar/teach.cjs');
      // (No Claude on this PC: Kea's shared Claude is the only way, when the account server offers it.)
      pc.req('./assistantPlan.cjs').findClaude = async () => null;
      await step('Teach is offered through the Kea account only when the server has sharedTeach', async () => {
        const r = await teach.route();
        check(r.via === (sharedTeach ? 'shared' : 'none'), `route ${r.via} with sharedTeach ${sharedTeach}`);
        return r.via;
      });
      const worker = pc.hub._teach;
      if (!sharedTeach) {
        await step('older server: the lesson writer hears there are no lessons, and waits', async () => {
          const r = await worker.teachOnce(ownerCall, { wait: 0 });
          check(r === 'unsupported', `teachOnce: ${JSON.stringify(r)}`);
        });
      } else {
        const FAKE = [process.execPath, path.join(spec.keaDir, 'test', 'sharedclaude', 'fake-claude.cjs')];
        await step('a lesson end to end: asked by Kea, written by the owner’s Kea (Sonnet), streamed back', async () => {
          check((await worker.teachOnce(ownerCall, { wait: 0 })) === null, 'nothing waiting yet');
          const pieces = [];
          const asking = pc.hub.requestTeach({ question: { type: 'mc', q: 'What is the pH of pure water?', choices: ['5', '7'], answer: 1 }, courseCode: 'CHEM 1010', answer: 0, right: false, model: 'claude-fable-5-1' }, (t) => pieces.push(t), { waitMs: 3000 });
          asking.catch(() => {}); // (awaited below; a refusal is reported there)
          const log = path.join(mk('claude'), 'runs.log');
          const job = await worker.teachOnce(ownerCall, { wait: 5000, claude: FAKE, cwd: os.tmpdir(), env: { ...process.env, FAKE_CLAUDE_LOG: log }, flushMs: 5 });
          check(job && job.model === 'claude-sonnet-5-5' && job.effort === 'medium', `job ${JSON.stringify(job)}`);
          const got = await asking;
          check(/pH is 7/.test(got.text) && pieces.join('') === got.text, `text ${JSON.stringify(got.text)} from ${pieces.length} pieces`);
          const run = JSON.parse(fs.readFileSync(log, 'utf8').trim());
          check(run.args[run.args.indexOf('--model') + 1] === 'claude-sonnet-5-5', `ran ${run.args.join(' ')}`);
          return { pieces: pieces.length, model: job.model };
        });
        await step('the lesson’s tokens are counted for the account', async () => {
          const u = ok(await owner('GET', '/owner/usage?days=1'));
          const t = u.totals.today;
          check(t.input === 1200 && t.output === 640 && t.cacheRead === 3000 && t.cacheWrite === 450, `usage ${JSON.stringify(t)}`);
          return { tokens: t.tokens };
        });
        await step('at the daily lesson limit: a plain refusal naming the limit and the person’s own Claude', async () => {
          ok(await owner('POST', '/owner/settings', { limits: { explainersPerDay: 1 } }));
          let err = null;
          try {
            await pc.hub.requestTeach({ question: { type: 'mc', q: 'Again?', choices: ['a', 'b'], answer: 0 } }, () => {});
          } catch (e) {
            err = e;
          }
          check(err && err.status === 429 && err.data?.limit === 'explainersPerDay', `refusal ${err && JSON.stringify({ s: err.status, d: err.data })}`);
          const msg = pc.hub.sharedClaudeMessage(err);
          check(/lesson/.test(msg) && /own Claude/.test(msg) && !/UTC/.test(msg), msg);
          return msg;
        });
      }
    } else {
      await step('older Kea: no shared Teach in it (it never asks)', async () => {
        check(!has('scholar/usage.cjs') && typeof pc.hub.requestTeach !== 'function', 'this Kea has requestTeach');
      });
      if (sharedTeach) {
        await step('no lessons without a Kea that writes them: a clear refusal', async () => {
          const me = ok(await call(base, 'POST', '/v1/auth/google', { body: { idToken: google.token('sc-person@compat.test') } }));
          const r = await call(base, 'POST', '/v1/teach', { token: me.token, body: { question: { type: 'mc', q: 'x?', choices: ['a'], answer: 0 } } });
          check(r.status === 503 && r.body.code === 'no_worker' && /own Claude/.test(r.body.error), JSON.stringify(r));
          return r.body.code;
        });
      }
    }

    // ---- The scan worker: the locked model, and the job's usage with its finish ----
    await step('a scan job: the server hands out the locked model (when it knows it), and the worker reports usage', async () => {
      const me = ok(await call(base, 'POST', '/v1/auth/google', { body: { idToken: google.token('sc-person@compat.test') } }));
      const q = ok(await call(base, 'POST', '/v1/scan', { token: me.token, body: { kind: 'more_questions', course: { school: 'UCCS', code: 'CHEM 1010', term: 'Fall 2026' }, chapter: 'Ch 1', model: 'claude-fable-5-1', detail: { courseCode: 'CHEM 1010', chapter: 'Ch 1', model: 'claude-fable-5-1' } } }));
      const job = ok(await owner('POST', '/owner/scan/next', {})).job;
      check(job?.id === q.job.id, 'the job');
      if (usageTracking) check(job.model === 'claude-opus-5-5', `model ${job.model}`);
      if (newKea) {
        const { checkJob } = pc.req('./scholar/usage.cjs');
        checkJob(job);
        let refused = false;
        try {
          checkJob({ ...job, model: 'claude-fable-5-1' });
        } catch {
          refused = true;
        }
        check(refused, 'a Fable job is refused by the worker');
      }
      // This Kea's own worker module (remote.cjs) reports the finish: with usage when it counts it, without when older.
      const keyFile = path.join(mk('key'), 'owner.key');
      fs.writeFileSync(keyFile, keac.ownerKey);
      Object.assign(process.env, { KEA_WORKER_JOB: job.id, KEA_OWNER_KEY_FILE: keyFile, KEA_HUB_OWNER_PORT: String(ports.ownerPort) });
      delete Module._cache[pc.req.resolve('./scholar/remote.cjs')];
      const remote = pc.req('./scholar/remote.cjs');
      const usage = newKea ? { byModel: { 'claude-opus-5-5': { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 } } } : undefined;
      await remote.finish(true, 'done', usage);
      delete process.env.KEA_WORKER_JOB;
      if (usageTracking) {
        const u = ok(await owner('GET', '/owner/usage?days=1'));
        const qs = u.totals.byKind.questions;
        check(qs && qs.jobs === 1 && qs.untracked === (newKea ? 0 : 1) && qs.input === (newKea ? 10 : 0), `questions usage ${JSON.stringify(qs)}`);
        return { untracked: qs.untracked };
      }
      return 'older server: finish accepted';
    });

    // ---- Where jobs run: the owner's API credits or plan (KeaC apiBackend, Kea's scholar/backend.cjs) ----
    const backendsKea = has('scholar/backend.cjs');
    const FAKE = [process.execPath, path.join(spec.keaDir, 'test', 'sharedclaude', 'fake-claude.cjs')];
    const api = createRequire(path.join(spec.keaDir, 'test', 'x.cjs'))('./sharedclaude/fake-api.cjs');
    const worker = pc.hub._teach;
    // (This Kea's account: a fresh sign-in token, and its id from the owner console.)
    const token = async () => ok(await call(base, 'POST', '/v1/auth/google', { body: { idToken: google.token('sc-person@compat.test') } })).token;
    const personId = async () => ok(await owner('GET', '/owner/accounts?q=sc-person%40compat.test')).accounts[0].id;
    // (The lesson limit from the steps above, lifted for these.)
    if (sharedTeach) ok(await owner('POST', '/owner/settings', { limits: { explainersPerDay: 100 } }));
    if (apiBackend) ok(await owner('POST', '/owner/settings', { api: { backend: 'auto' } }));
    /** One lesson asked for by this Kea and written by the owner's Kea with `opts` (a stand-in API fetch, claude). */
    const lesson = async (opts) => {
      check((await worker.teachOnce(ownerCall, { wait: 0 })) === null, 'nothing waiting yet');
      const asking = pc.hub.requestTeach({ question: { type: 'mc', q: 'What is the pH of pure water?', choices: ['5', '7'], answer: 1 }, courseCode: 'CHEM 1010', answer: 0, right: false }, () => {}, { waitMs: 3000 });
      asking.catch(() => {});
      const job = await worker.teachOnce(ownerCall, { wait: 5000, cwd: os.tmpdir(), env: { ...process.env }, flushMs: 5, ...opts });
      let got = null, err = null;
      try {
        got = await asking;
      } catch (e) {
        err = e;
      }
      return { job, got, err };
    };
    const byBackend = async () => ok(await owner('GET', '/owner/usage?days=1')).totals.byBackend || {};
    if (apiBackend && backendsKea && sharedTeach && newKea) {
      await step('a lesson on API credits: handed out as auto to a Kea that runs both, written through the Messages API (a stand-in), counted as API', async () => {
        const f = api.lessonFetch();
        const before = (await byBackend()).api?.output || 0;
        const { job, got, err } = await lesson({ fetch: f, claude: FAKE });
        check(!err, `lesson failed: ${err?.message}`);
        check(job.backend === 'auto', `backend ${job.backend}`);
        check(/pH is 7/.test(got.text), `text ${JSON.stringify(got?.text)}`);
        check(f.calls.length === 1 && f.calls[0].headers.get('x-api-key') === API_KEY && f.calls[0].body.model === 'claude-sonnet-5-5', 'one Messages API call with the key, on Sonnet');
        const now = (await byBackend()).api?.output || 0;
        check(now - before === api.USAGE.output, `api output ${before} -> ${now}`);
        return { backend: job.backend };
      });
      await step('auto: the API’s billing error writes the lesson on the plan instead, and the owner sees when it moved', async () => {
        const f = api.billingFetch();
        const log = path.join(mk('claude'), 'runs.log');
        const { got, err } = await lesson({ fetch: f, claude: FAKE, env: { ...process.env, FAKE_CLAUDE_LOG: log } });
        check(!err, `lesson failed: ${err?.message}`);
        check(/pH is 7/.test(got.text), 'written');
        check(fs.existsSync(log), 'written on the plan');
        const cr = ok(await owner('GET', '/owner/settings')).api.credits;
        check(cr.out === true && Number.isFinite(cr.at) && /credit balance/.test(cr.reason), `credits ${JSON.stringify(cr)}`);
        ok(await owner('POST', '/owner/claude/api-retry', {}));
        return { movedAt: new Date(cr.at).toISOString() };
      });
      await step('API credits only with no key set: the owner’s Kea refuses it; the person hears only that it isn’t available', async () => {
        const id = await personId();
        ok(await owner('POST', `/owner/accounts/${id}/claude`, { backend: 'api' }));
        apiKey = null;
        const f = api.lessonFetch();
        const { job, err } = await lesson({ fetch: f, claude: FAKE });
        apiKey = API_KEY;
        ok(await owner('POST', `/owner/accounts/${id}/claude`, { backend: null }));
        check(job.backend === 'api', `backend ${job.backend}`);
        check(err && NOT_AVAILABLE.test(err.message), `the person saw: ${err?.message}`);
        check(!/API|KeaC|key/.test(err.message), `nothing about the backend: ${err.message}`);
        check(f.calls.length === 0, 'nothing sent to the API');
        return err.message;
      });
      await step('a scan job on API credits: the worker reads its backend, gets the key over the owner console, and reports where it ran', async () => {
        const t = await token();
        const q = ok(await call(base, 'POST', '/v1/scan', { token: t, body: { kind: 'more_questions', course: { school: 'UCCS', code: 'BIO 1010', term: 'Fall 2026' }, chapter: 'Ch 2', detail: { courseCode: 'BIO 1010', chapter: 'Ch 2' } } }));
        const job = ok(await owner('POST', '/owner/scan/next', { backends: ['api', 'plan'] })).job;
        check(job?.id === q.job.id && job.backend === 'auto', `job ${JSON.stringify(job)}`);
        const keyFile = path.join(mk('key'), 'owner.key');
        fs.writeFileSync(keyFile, keac.ownerKey);
        Object.assign(process.env, { KEA_WORKER_JOB: job.id, KEA_OWNER_KEY_FILE: keyFile, KEA_HUB_OWNER_PORT: String(ports.ownerPort) });
        delete Module._cache[pc.req.resolve('./scholar/remote.cjs')];
        const remote = pc.req('./scholar/remote.cjs');
        const B = pc.req('./scholar/backend.cjs');
        const info = await remote.jobInfo();
        const key = await remote.apiKey();
        check(key === API_KEY, 'the key, for this running job');
        check(JSON.stringify(B.choose(info.job, { hasKey: !!key })) === JSON.stringify({ run: 'api', auto: true }), 'runs on the API credits');
        const before = (await byBackend()).api?.input || 0;
        const usage = { byModel: { 'claude-opus-5-5': { input: 11, output: 22, cacheRead: 33, cacheWrite: 44 } } };
        await remote.finish(true, 'done', usage, { backend: 'api', usageByBackend: { api: usage } });
        delete process.env.KEA_WORKER_JOB;
        check((await byBackend()).api.input - before === 11, 'counted as API');
        check(ok(await owner('GET', '/owner/scan/history')).jobs.find((j) => j.id === job.id)?.ranOn === 'api', 'the owner sees it ran on API credits');
        return 'api';
      });
      await step('the key is nowhere in KeaC’s data folder (database, logs) after all of it', async () => {
        keac.h.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        const files = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(d, e.name)) : [path.join(d, e.name)]));
        for (const f of files(keacData)) check(!fs.readFileSync(f).includes(Buffer.from(API_KEY)), `the key is in ${f}`);
      });
    } else if (apiBackend && sharedTeach && !backendsKea && has('scholar/usage.cjs')) {
      await step('an older Kea (it doesn’t say it runs backends) writes auto lessons on its plan, and never gets one for API credits only', async () => {
        const { job, err } = await lesson({ claude: FAKE });
        check(!err && job && job.backend === undefined, `auto lesson: ${err?.message} ${JSON.stringify(job && job.backend)}`);
        check(((await byBackend()).plan?.jobs || 0) >= 1, 'counted on the plan');
        const id = await personId();
        ok(await owner('POST', `/owner/accounts/${id}/claude`, { backend: 'api' }));
        const r = await lesson({ claude: FAKE });
        ok(await owner('POST', `/owner/accounts/${id}/claude`, { backend: null }));
        check(r.job === null, 'the API-only lesson was never handed to it');
        check(r.err && NOT_AVAILABLE.test(r.err.message), `the person saw: ${r.err?.message}`);
        return r.err.message;
      });
    } else if (!apiBackend && backendsKea && newKea) {
      await step('an older KeaC (no backends): the job comes without one and the owner’s Kea runs it on the plan', async () => {
        if (sharedTeach) {
          const f = api.lessonFetch();
          const { job, err } = await lesson({ fetch: f, claude: FAKE });
          check(!err && job && job.backend === undefined, `lesson: ${err?.message}`);
          check(f.calls.length === 0, 'the API was never used');
        }
        const B = pc.req('./scholar/backend.cjs');
        check(JSON.stringify(B.choose({ kind: 'initial_scan' }, { hasKey: true })) === JSON.stringify({ run: 'plan', auto: false }), 'a job without a backend runs on the plan');
        return 'plan';
      });
    }
  } finally {
    await keac.close();
  }
}
let fatal = null;
// (A stray rejection is reported as a failed step, never a crash without a result.)
process.on('unhandledRejection', (e) => steps.push({ name: 'unhandled rejection', ok: false, error: String(e?.stack || e).slice(0, 2000) }));
if (specFile) {
  try {
    await main(JSON.parse(fs.readFileSync(specFile, 'utf8')));
  } catch (e) {
    fatal = String(e?.stack || e);
  }
  fs.writeFileSync(outFile, JSON.stringify({ steps, fatal }, null, 1));
  for (const d of scratch) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 });
  process.exit(0);
}
