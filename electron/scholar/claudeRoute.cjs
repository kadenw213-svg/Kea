// Which Claude does the work: the person's own first, Kea's shared Claude only as a fallback (the owner's decision).
//
// - Own Claude: Claude Code on this PC (signed in with their Claude account). Every Claude feature uses it first:
//   class scans, practice questions, guides and Teach lessons.
// - Kea's shared Claude (the Kea owner's plan, through the Kea account) is used only when:
//     * this PC has no Claude connected, or
//     * their own run failed because Claude Code is signed out, or because their plan hit its usage limit
//       (read from Claude Code's own error and usage-limit output: never an ordinary failure such as a bad prompt,
//       a server hiccup or a run they stopped).
// - Every fallback is still a shared-Claude request: the account's limits and the locked models apply.
// - Settings → Claude Assistant → "Use my own Claude" (claude.ownOnly, off by default; also beside every mention of
//   the shared Claude) turns the fallback off: more privacy and no shared limits. (It replaces the Advanced setting
//   claude.sharedFallback; someone who had turned that off has "Use my own Claude" on.)
const settings = () => require('../settings.cjs');

// Claude Code's usage-limit messages (the same reading as runner.cjs's pause), and its signed-out ones.
const LIMIT = /hit your (?:session |usage |weekly |daily |5-hour |opus )?limit|usage limit reached|limit (?:will )?resets?|Claude AI usage limit|reached your Claude plan’s usage limit/i;
const SIGNED_OUT = /not logged in|please run \/?login|invalid api key|oauth token (?:has )?expired|authentication_error|isn’t signed in/i;

const NOTES = {
  limit: 'Used the shared Claude because yours is at its limit.',
  signedOut: 'Used the shared Claude because yours is signed out.',
  none: 'Used the shared Claude because this PC has no Claude connected.',
};

/** Whether only this person's own Claude is used, never Kea's shared Claude ("Use my own Claude"). */
function ownOnly() {
  const v = settings().get('claude.ownOnly', null);
  if (v != null) return v === true;
  // (Carried over once from the old Advanced setting, so the switch shows what Kea does.)
  if (settings().get('claude.sharedFallback', true) === false) {
    try {
      settings().set({ 'claude.ownOnly': true });
    } catch {}
    return true;
  }
  return false;
}
/** Whether falling back to Kea's shared Claude is allowed. */
const fallbackOn = () => !ownOnly();

/**
 * Why an own run's failure allows the fallback: 'limit', 'signedOut', or null (an ordinary failure, or a stopped run).
 * `text`: Claude Code's error output and failed result. `stopped`: the person (or Kea) stopped it.
 */
function fallbackReason(text, { stopped = false } = {}) {
  if (stopped) return null;
  const t = String(text || '');
  if (LIMIT.test(t)) return 'limit';
  if (SIGNED_OUT.test(t)) return 'signedOut';
  return null;
}
const noteFor = (reason) => NOTES[reason] || NOTES.none;

module.exports = { ownOnly, fallbackOn, fallbackReason, noteFor, NOTES, LIMIT, SIGNED_OUT };
