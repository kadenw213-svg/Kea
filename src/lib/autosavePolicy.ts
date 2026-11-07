/**
 * What autosave does after an attempt. Kept free of imports so it can be tested on its own.
 *  - held: the editor said this change needs an explicit Save (it would destroy or drop something). Never retry;
 *    the next edit asks again.
 *  - busy: the editor couldn't save this moment (mid-edit in a cell or text box). Retry a few times, then wait
 *    for the next edit instead of looping forever.
 */
export const AUTOSAVE_RETRY_MS = 4000;
export const AUTOSAVE_MAX_RETRIES = 15;

export interface AttemptOutcome {
  held: boolean;
  saved: boolean;
  /** Tab still has unsaved changes and a place to save them. */
  stillDirty: boolean;
  /** Retries already made for this run of edits. */
  tries: number;
}

export function nextAutosaveStep(o: AttemptOutcome): 'done' | 'retry' | 'stop' {
  if (o.saved || !o.stillDirty) return 'done';
  if (o.held) return 'stop';
  return o.tries < AUTOSAVE_MAX_RETRIES ? 'retry' : 'stop';
}
