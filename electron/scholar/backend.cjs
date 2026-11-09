// Where Kea's shared Claude runs a job on the Kea owner's PC (the owner's decision, sent with each job by the account
// server; never shown to the person who asked):
//
//   api    the owner's Claude API credits, with the owner's API key. Teach lessons: one streamed Messages API call
//          (teach.cjs). Scans, light checks, questions and guides: the same run through the Claude Agent SDK
//          (agentRun.cjs) instead of the claude command, with the same tools, rules, prompts and locked models.
//   plan   Claude Code on the owner's Claude plan, as before.
//   auto   api; when the API says the credit balance is too low (a billing error: below), this job runs on the plan
//          instead, and the account server is told, so the rest of the billing cycle goes to the plan (it tries the API
//          again once a day, or when the owner asks). Any other error is the job's own error: never a move to the plan.
//
// A job from an account server that doesn't send a backend (an older one) runs on the plan. A job this PC can't run on
// its backend (API credits only, with no API key set) is refused with the reason, for the owner; the person only hears
// that the shared Claude isn't available right now. It is never quietly run on the other one.
//
// The key: the owner's, kept by KeaC's desktop app on this PC (encrypted with Windows), and asked for over the owner
// console on 127.0.0.1 for each running job that may use it. It is held in memory for that job only, sent only to the
// Anthropic API, and never written to a file, a log, a job record or a report (redact() takes it out of anything
// written).
const Anthropic = require('@anthropic-ai/sdk');

/** What a worker can run, told to the account server when it asks for a job. */
const BACKENDS = ['api', 'plan'];
const NO_KEY = 'This job runs on API credits only, and no Claude API key is set in KeaC (Settings → Shared Claude).';

/**
 * How to run a job: { run: 'api' | 'plan', auto } or { refuse: reason }.
 *   job.backend: 'auto' | 'api' | 'plan' (missing: an older account server; the plan, as always).
 *   hasKey: an API key came with it.
 */
function choose(job, { hasKey }) {
  const want = job?.backend;
  if (want === 'api') return hasKey ? { run: 'api', auto: false } : { refuse: NO_KEY };
  if (want === 'auto') return hasKey ? { run: 'api', auto: true } : { run: 'plan', auto: true, noKey: true };
  return { run: 'plan', auto: false };
}
/** Whether this job may use the API key at all (so it's only asked for then). */
const wantsKey = (job) => job?.backend === 'api' || job?.backend === 'auto';

/**
 * The API's billing error: the credit balance is too low or used up. The Claude API answers it as HTTP 402 with the
 * error type "billing_error"; an older form of the same answer is a 400 whose message says the credit balance is too
 * low. Nothing else counts (a rate limit, an overloaded or failing server, a bad key, a refusal: not a billing error).
 */
function isBillingError(err) {
  if (!(err instanceof Anthropic.APIError)) return false;
  const type = err.type ?? err.error?.error?.type ?? err.error?.type ?? null;
  if (err.status === 402 || type === 'billing_error') return true;
  return err.status === 400 && /credit balance is too low/i.test(String(err.message || ''));
}
/**
 * The same for an Agent SDK run: an assistant message carrying error 'billing_error' (the SDK's own name for it), or a
 * failed result whose text is the API's credit-balance answer.
 */
function isBillingMessage(m) {
  if (!m || typeof m !== 'object') return false;
  if (m.type === 'assistant' && m.error === 'billing_error') return true;
  if (m.type === 'result' && m.is_error) return /credit balance is too low/i.test(`${m.result || ''} ${(m.errors || []).join(' ')}`);
  return false;
}
const BILLING_REASON = 'The Claude API said the credit balance is too low.';

/** `text` with the key taken out (for anything that's written down or sent anywhere but the API). */
function redact(text, key) {
  const s = String(text ?? '');
  return key && key.length >= 8 ? s.split(key).join('[api key]') : s;
}

/** Usage from one Messages API message: { byModel: { model: { input, output, cacheRead, cacheWrite } } }. */
function usageOfMessage(msg, fallbackModel) {
  const u = msg?.usage;
  if (!u) return null;
  const n = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  // (With a server-side fallback, each model that ran has its own iteration.)
  const its = Array.isArray(u.iterations) && u.iterations.length ? u.iterations : null;
  const byModel = {};
  const add = (model, x) => {
    const t = (byModel[model] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    t.input += n(x.input_tokens);
    t.output += n(x.output_tokens);
    t.cacheRead += n(x.cache_read_input_tokens);
    t.cacheWrite += n(x.cache_creation_input_tokens);
  };
  if (its) for (const it of its) add(it.model || msg.model || fallbackModel, it);
  else add(msg.model || fallbackModel, u);
  return { byModel };
}

module.exports = { BACKENDS, NO_KEY, BILLING_REASON, choose, wantsKey, isBillingError, isBillingMessage, redact, usageOfMessage };
