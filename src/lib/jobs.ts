// A small renderer-side registry for long-running work (indexing a clip, exporting a video). A tool starts a job and
// returns its id immediately; an MCP agent polls kea_jobs_status until it's done, then reads the result (kept small —
// heavy output like a transcript or contact sheet goes to MCP resources, not the job result). The in-app UI can use
// these too. Work runs here in the renderer because that's where decode, the Whisper worker and the compositor live.
import { uid } from './util';

export interface JobView {
  id: string;
  kind: string;
  status: 'running' | 'done' | 'error' | 'canceled';
  /** 0..1 */
  progress: number;
  note: string;
  error?: string;
  /** Present only when status is 'done'. Kept small. */
  result?: any;
}

interface Job extends JobView {
  ctrl: AbortController;
  startedAt: number;
}

const jobs = new Map<string, Job>();
const order: string[] = [];
const KEEP = 20;

/** Start a job. `run(onProgress, signal)` does the work; its resolved value becomes the job result. Returns the id. */
export function startJob(kind: string, run: (onProgress: (progress: number, note?: string) => void, signal: AbortSignal) => Promise<any>): string {
  const id = uid();
  const job: Job = { id, kind, status: 'running', progress: 0, note: '', ctrl: new AbortController(), startedAt: Date.now() };
  jobs.set(id, job);
  order.push(id);
  // Forget old finished jobs, but never a still-running one.
  while (order.length > KEEP) {
    const i = order.findIndex((x) => jobs.get(x)?.status !== 'running');
    if (i < 0) break;
    jobs.delete(order.splice(i, 1)[0]);
  }
  Promise.resolve()
    .then(() =>
      run((p, note) => {
        if (job.status !== 'running') return;
        job.progress = Math.max(0, Math.min(1, p));
        if (note !== undefined) job.note = note;
      }, job.ctrl.signal)
    )
    .then((result) => {
      if (job.status === 'running') {
        job.status = 'done';
        job.progress = 1;
        job.result = result;
      }
    })
    .catch((err) => {
      if (job.status === 'canceled') return;
      job.status = 'error';
      job.error = String(err?.message || err);
    });
  return id;
}

const view = (j: Job): JobView => ({ id: j.id, kind: j.kind, status: j.status, progress: Math.round(j.progress * 100) / 100, note: j.note, error: j.error, result: j.status === 'done' ? j.result : undefined });

/** One job (by id) or all of them, newest last. */
export function jobStatus(id?: string): JobView | JobView[] | null {
  if (id) {
    const j = jobs.get(id);
    return j ? view(j) : null;
  }
  return order.map((i) => jobs.get(i)).filter(Boolean).map((j) => view(j as Job));
}

/** Cancel a running job; returns false if it's unknown or already finished. */
export function cancelJob(id: string): boolean {
  const j = jobs.get(id);
  if (!j || j.status !== 'running') return false;
  j.status = 'canceled';
  j.note = 'Canceled.';
  j.ctrl.abort();
  return true;
}
