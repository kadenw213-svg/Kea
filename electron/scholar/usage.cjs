// Kea's shared Claude on the owner's PC: the one model each kind of job may run on, and what a job used.
//
// The models are the owner's decision and can't be changed by whoever asks (the Kea account server has the same
// table and hands each job out with its model; a job that names another is refused here):
//   class scans, light checks, practice questions, assignment guides   Opus   (claude-opus-5-5)
//   Teach explainers (lessons and follow-ups)                          Sonnet (claude-sonnet-5-5), effort medium
// Never Fable or any other model on the owner's plan, whatever the owner's own settings say for their own Kea.
//
// Usage: Claude Code's stream-json `result` event carries `usage` (input_tokens, output_tokens,
// cache_read_input_tokens, cache_creation_input_tokens) and, per model, `modelUsage` (inputTokens, outputTokens,
// cacheReadInputTokens, cacheCreationInputTokens). A job adds up every run's result and sends the total with its
// finish, so the account server can count it against the person's daily cap.
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
const LOCKED = {
  initial_scan: { model: OPUS, effort: null },
  update_scan: { model: OPUS, effort: null },
  more_questions: { model: OPUS, effort: null },
  guide: { model: OPUS, effort: null },
  explain: { model: SONNET, effort: 'medium' },
};
/** The locked model and effort for a job kind (anything unknown: Opus, the scan model). */
const lockedFor = (kind) => LOCKED[kind] || { model: OPUS, effort: null };

/**
 * Throws when a job from the account server names a model or effort other than the locked one for its kind (a server
 * that names none, an older one, is fine: the locked one is used either way).
 */
function checkJob(job) {
  const want = lockedFor(job?.kind);
  if (job?.model != null && job.model !== want.model) throw new Error(`This job asks for ${job.model}, but Kea’s shared Claude runs ${want.model} for it.`);
  if (job?.effort != null && want.effort != null && job.effort !== want.effort) throw new Error(`This job asks for effort ${job.effort}, but Kea’s shared Claude uses ${want.effort} for it.`);
  return want;
}

const n = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
/** One `result` event's usage: { byModel: { model: { input, output, cacheRead, cacheWrite } } }, or null. */
function usageOf(ev, fallbackModel = OPUS) {
  if (!ev || ev.type !== 'result') return null;
  const byModel = {};
  if (ev.modelUsage && typeof ev.modelUsage === 'object' && Object.keys(ev.modelUsage).length) {
    for (const [m, u] of Object.entries(ev.modelUsage))
      byModel[m] = { input: n(u?.inputTokens), output: n(u?.outputTokens), cacheRead: n(u?.cacheReadInputTokens), cacheWrite: n(u?.cacheCreationInputTokens) };
  } else if (ev.usage && typeof ev.usage === 'object') {
    const u = ev.usage;
    byModel[fallbackModel] = { input: n(u.input_tokens), output: n(u.output_tokens), cacheRead: n(u.cache_read_input_tokens), cacheWrite: n(u.cache_creation_input_tokens) };
  } else return null;
  return { byModel };
}
/** a + b (either may be null). */
function addUsage(a, b) {
  if (!b) return a;
  const out = { byModel: { ...(a?.byModel || {}) } };
  for (const [m, u] of Object.entries(b.byModel)) {
    const t = (out.byModel[m] = { ...(out.byModel[m] || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) });
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) t[k] += u[k] || 0;
  }
  return out;
}
/** A running total over a job's runs: add(ev) for each stream-json event (only `result` events count). */
function tally(fallbackModel = OPUS) {
  let total = null;
  return {
    add(ev) {
      total = addUsage(total, usageOf(ev, fallbackModel));
    },
    get: () => total,
    reset() {
      total = null;
    },
  };
}

module.exports = { OPUS, SONNET, LOCKED, lockedFor, checkJob, usageOf, addUsage, tally };
