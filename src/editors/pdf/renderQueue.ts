/**
 * Page rendering is the heaviest thing the PDF editor does. Running every
 * near-visible page at once makes scrolling stutter, so renders go through a
 * small queue: two at a time, closest to the viewport first.
 */
interface Job {
  priority: number;
  run: () => Promise<void>;
  cancelled: boolean;
}

const MAX_ACTIVE = 2;
let active = 0;
const queue: Job[] = [];

function pump() {
  while (active < MAX_ACTIVE && queue.length) {
    queue.sort((a, b) => a.priority - b.priority);
    const job = queue.shift()!;
    if (job.cancelled) continue;
    active++;
    job
      .run()
      .catch(() => {})
      .finally(() => {
        active--;
        // Yield a frame between renders so scrolling stays responsive.
        requestAnimationFrame(pump);
      });
  }
}

/** Queue a render. Lower priority runs first. Returns a cancel function. */
export function scheduleRender(priority: number, run: () => Promise<void>): () => void {
  const job: Job = { priority, run, cancelled: false };
  queue.push(job);
  pump();
  return () => {
    job.cancelled = true;
  };
}

/** Distance of an element from the middle of its scroll container, used as priority. */
export function distanceFromView(el: Element | null, root: Element | null): number {
  if (!el) return 1e9;
  const r = el.getBoundingClientRect();
  const v = root ? root.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
  const mid = (v.top + v.bottom) / 2;
  if (r.bottom >= v.top && r.top <= v.bottom) return Math.abs((r.top + r.bottom) / 2 - mid) / 10000;
  return Math.min(Math.abs(r.top - mid), Math.abs(r.bottom - mid));
}
