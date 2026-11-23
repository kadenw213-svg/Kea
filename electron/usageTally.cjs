// Approximate Claude usage on this PC (Kea 0.101): every Claude run Kea starts on the person's own Claude (the Claude
// panel and Claude pages on their plan or API key, class scans and guides, study lessons), in tokens, per day (UTC),
// feature and model, with how often each tool was called. It's an estimate: what Claude Code and the API report back.
//
// - The Claude panel's Usage menu shows it to the person (today, 7 and 30 days, by feature, with an API-equivalent
//   cost estimate).
// - With Settings → Privacy → "Share approximate Claude usage with Kea" (privacy.shareUsage, on unless turned off),
//   the last 3 days' totals go to the Kea account (KeaC: POST /v1/usage/report) so Kea's developer can see which
//   features and tools cost the most and make them leaner. Only counts, feature names, models and tool names are sent:
//   never prompts, files or answers. Rows are full totals that replace what was sent before, so a retry never counts
//   twice. Turning it off stops it; "Delete what was sent" calls DELETE /v1/usage/report.
const fs = require('fs');
const path = require('path');
const { app, ipcMain } = require('electron');
const { handleApp } = require('./ipcGuard.cjs');
const settings = require('./settings.cjs');

const KEEP_DAYS = 400;
const REPORT_DAYS = 3;
const file = () => path.join(app.getPath('userData'), 'usage-tally.json');
const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'];
// USD per million tokens, for the estimate only (Anthropic's list prices for these families).
const PRICES = {
  opus: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  sonnet: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  haiku: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  fable: { input: 6, output: 30, cacheRead: 0.3, cacheWrite: 7.5 },
};
const priceOf = (model) => PRICES[Object.keys(PRICES).find((k) => String(model).includes(k)) || 'opus'];

let data = null;
function load() {
  if (data) return data;
  try {
    data = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (!data || typeof data.days !== 'object') throw 0;
  } catch {
    data = { days: {} };
  }
  return data;
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(file(), JSON.stringify(data));
    } catch {}
  }, 1500);
}
const today = () => new Date().toISOString().slice(0, 10);
const cleanFeature = (f) => String(f || 'other').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 40) || 'other';
const cleanModel = (m) => String(m || 'unknown').replace(/[^A-Za-z0-9._:-]+/g, '').slice(0, 80) || 'unknown';
const cleanTool = (t) => String(t || '').replace(/^mcp__kea__/, '').replace(/[^A-Za-z0-9_.:-]+/g, '').slice(0, 64);
const num = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/**
 * Add one run's usage. `byModel`: { model: { input, output, cacheRead, cacheWrite } } (scholar/usage.cjs usageOf).
 * `tools`: tool names called during it (each counts once per call). `calls`: Claude requests (default 1).
 */
function record(feature, byModel, tools = [], calls = 1) {
  if (!byModel || typeof byModel !== 'object') return;
  const d = load();
  const day = (d.days[today()] ||= {});
  const f = (day[cleanFeature(feature)] ||= {});
  const models = Object.keys(byModel);
  models.forEach((m, i) => {
    const row = (f[cleanModel(m)] ||= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, toolCalls: {} });
    for (const k of FIELDS) row[k] += num(byModel[m]?.[k]);
    // Calls and tools go on the first model of the run (the one that drove it).
    if (i === 0) {
      row.calls += num(calls) || 1;
      for (const t of tools) {
        const name = cleanTool(t);
        if (name && (row.toolCalls[name] || Object.keys(row.toolCalls).length < 60)) row.toolCalls[name] = (row.toolCalls[name] || 0) + 1;
      }
    }
  });
  // Old days go.
  const cutoff = new Date(Date.now() - KEEP_DAYS * 864e5).toISOString().slice(0, 10);
  for (const k of Object.keys(d.days)) if (k < cutoff) delete d.days[k];
  save();
  scheduleReport();
}

/** A Claude Code stream-json `result` event (its modelUsage, else usage). */
function recordResult(feature, ev, tools = [], fallbackModel = 'claude-opus-5-5') {
  const u = require('./scholar/usage.cjs').usageOf(ev, fallbackModel);
  if (u) record(feature, u.byModel, tools, ev?.num_turns || 1);
}

/** Totals for the last `days` days (today included), overall and by feature, with the API-equivalent estimate. */
function summary(days = 30) {
  const d = load();
  const from = new Date(Date.now() - (Math.max(1, days) - 1) * 864e5).toISOString().slice(0, 10);
  const blank = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, cost: 0 });
  const total = blank();
  const byFeature = {};
  const byModel = {};
  for (const [day, feats] of Object.entries(d.days)) {
    if (day < from) continue;
    for (const [feat, models] of Object.entries(feats))
      for (const [model, r] of Object.entries(models)) {
        const p = priceOf(model);
        const cost = FIELDS.reduce((s, k) => s + (r[k] * p[k]) / 1e6, 0);
        for (const t of [total, (byFeature[feat] ||= blank()), (byModel[model] ||= blank())]) {
          for (const k of FIELDS) t[k] += r[k];
          t.calls += r.calls;
          t.cost += cost;
        }
      }
  }
  return { days, total, byFeature, byModel };
}

/** The rows the Kea account gets: the last few days, full totals. */
function rows() {
  const d = load();
  const out = [];
  for (let i = 0; i < REPORT_DAYS; i++) {
    const day = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    for (const [feature, models] of Object.entries(d.days[day] || {}))
      for (const [model, r] of Object.entries(models)) out.push({ day, feature, model, input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite, calls: r.calls, toolCalls: r.toolCalls || {} });
  }
  return out.slice(0, 500);
}

const sharing = () => settings.get('privacy.shareUsage', true) !== false;
let reportTimer = null;
let lastReport = 0;
/** Send soon after use (at most every 15 minutes), when sharing is on and the person is signed in. */
function scheduleReport(delay = 60_000) {
  if (reportTimer || !sharing()) return;
  const wait = Math.max(delay, lastReport + 15 * 60_000 - Date.now());
  reportTimer = setTimeout(() => {
    reportTimer = null;
    report().catch(() => {});
  }, wait);
  reportTimer.unref?.();
}
async function report() {
  if (!sharing()) return { ok: false, off: true };
  const hub = require('./hub.cjs');
  if (!hub.signedIn()) return { ok: false, signedOut: true };
  // (Only to a Kea account server that takes reports: features usageReports.)
  if (!(await require('./hubOrg.cjs').accountFeatures().catch(() => [])).includes('usageReports')) return { ok: false, unsupported: true };
  const r = rows();
  if (!r.length) return { ok: true, sent: 0 };
  lastReport = Date.now();
  await hub.req('POST', '/v1/usage/report', { client: { app: 'kea', version: app.getVersion() }, rows: r });
  return { ok: true, sent: r.length };
}

function register() {
  handleApp(ipcMain, 'usage:summary', (_e, days) => summary(Number(days) || 30));
  // From the window: a Claude panel run. `ev`: Claude Code's result event (on the plan); or `byModel` (API key).
  handleApp(ipcMain, 'usage:add', (_e, a) => {
    if (!a || typeof a !== 'object') return false;
    const tools = Array.isArray(a.tools) ? a.tools.slice(0, 200).map(String) : [];
    if (a.ev) recordResult(a.feature, a.ev, tools, a.model);
    else if (a.byModel) record(a.feature, a.byModel, tools, a.calls);
    return true;
  });
  handleApp(ipcMain, 'usage:forget', async () => {
    const hub = require('./hub.cjs');
    if (!hub.signedIn()) return { ok: false };
    try {
      const r = await hub.req('DELETE', '/v1/usage/report');
      return { ok: true, deleted: r?.deleted ?? 0 };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  });
  // Once a while after starting, in case Kea closed before a report went.
  setTimeout(() => scheduleReport(0), 5 * 60_000).unref?.();
}

module.exports = { register, record, recordResult, summary, rows, report, _test: { cleanFeature, priceOf, reset: () => (data = { days: {} }) } };
