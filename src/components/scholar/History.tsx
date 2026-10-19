// Why and when things changed: an item's history (from the engine's append-only record: created from which source,
// each change old → new, replaced or cancelled and why, which scan did it), and a "what changed" list for the week.
import { useEffect, useState } from 'react';
import { ChevronDown, History as HistoryIcon } from 'lucide-react';
import { api, HistoryEvent } from '../../lib/api';
import { useScholar } from './scholarStore';

const FIELD: Record<string, string> = {
  title: 'Name',
  item_type: 'Kind',
  date: 'Date',
  start_time: 'Start',
  end_time: 'End',
  due_time: 'Due time',
  date_range_end: 'Ends',
  status: 'Status',
  superseded_by_id: 'Replaced by',
  points: 'Points',
  is_optional: 'Optional',
  is_tentative: 'Tentative',
  reference_url: 'Link',
  submission_url: 'Hand-in link',
  resource_url: 'Material link',
  location_id: 'Place',
  platform_location: 'Platform',
  description: 'Instructions',
  covered_chapters_json: 'Chapters covered',
  study_focus_json: 'Study focus',
  module_label: 'Module',
  source_ids_json: 'Sources'
};
const show = (v: unknown) => {
  if (v === null || v === undefined || v === '') return 'none';
  const s = String(v).replace(/\.0+$/, '').replace(/:00\.000000$/, '');
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
};
/** Which scan made a change, in words. */
export function runLabel(run: string | null) {
  if (!run) return '';
  if (run === 'migration') return 'when history began';
  const task = run.split(':')[0];
  const names: Record<string, string> = { daily: 'the daily check', sync: 'a weekly update', import: 'a class scan', study: 'a textbook run', practice: 'a practice run', resume: 'a resumed scan' };
  if (names[task]) return names[task];
  return run.startsWith('manual') ? 'a manual fix' : run;
}

function describe(e: HistoryEvent): string {
  if (e.op === 'baseline') return e.reason || 'History starts here.';
  if (e.op === 'create') return 'Added to your calendar';
  if (e.op === 'source') return `Read a source: ${(e.changes as any)?.title || ''}`;
  if (e.op === 'unsync') return 'Taken off the synced calendar';
  if (e.op === 'dismiss') return 'Marked not separate work';
  const ch = (e.changes || {}) as Record<string, [unknown, unknown]>;
  const parts = Object.entries(ch)
    .filter(([k]) => k !== 'source_ids_json' && k !== 'superseded_by_id')
    .map(([k, [a, b]]) => `${FIELD[k] || k}: ${show(a)} → ${show(b)}`);
  const head = e.op === 'supersede' ? 'Replaced by another item' : e.op === 'cancel' ? 'Cancelled' : e.op === 'restore' ? 'Restored' : 'Changed';
  return parts.length ? `${head}: ${parts.join('; ')}` : head;
}

/** The History section of an item's panel. */
export function ItemHistory({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ events: HistoryEvent[]; sources: { title: string; source_type: string; url: string | null; retrieved_at: string }[] } | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!open || data) return;
    api.scholar
      .itemHistory(id)
      .then((d) => setData(d))
      .catch((e) => setErr(String(e?.message || e)));
  }, [open]);
  return (
    <section className="hs-box">
      <button className="hs-head" onClick={() => setOpen(!open)}>
        <HistoryIcon size={14} /> <span className="tb-h">History</span>
        <ChevronDown size={14} className={open ? 'flip' : ''} />
      </button>
      {open && (err ? <p className="muted">{err}</p> : !data ? <div className="spinner" /> : (
        <>
          {data.sources.length > 0 && (
            <div className="hs-sources muted">
              From: {data.sources.map((s) => s.title).join(' · ')}
            </div>
          )}
          <ol className="hs-list">
            {data.events.filter((e) => e.op !== 'source').map((e, i) => (
              <li key={i}>
                <div className="hs-when muted">
                  {new Date(e.ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
                  {e.op !== 'baseline' && runLabel(e.run) ? ` · ${runLabel(e.run)}` : ''}
                </div>
                <div>{describe(e)}</div>
                {e.reason && e.op !== 'baseline' && <div className="hs-why">Why: {e.reason}</div>}
              </li>
            ))}
          </ol>
        </>
      ))}
    </section>
  );
}

/** "What changed": everything added, moved, renamed, replaced or cancelled on the calendar this week, and why. */
export function ChangesBox() {
  const version = useScholar((s) => s.version);
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<(HistoryEvent & { title: string | null; course: string | null })[] | null>(null);
  useEffect(() => {
    api.scholar
      .changes({})
      .then((r) => setEvents(r.events.filter((e) => e.table === 'academic_items' || e.op === 'dismiss')))
      .catch(() => setEvents([]));
  }, [version]);
  if (!events || !events.length) return null;
  return (
    <section className="hs-changes">
      <button className="hs-head" onClick={() => setOpen(!open)}>
        <HistoryIcon size={15} /> <b>{events.length} calendar change{events.length === 1 ? '' : 's'} this week</b>
        <span className="muted">what was added, moved or removed, and why</span>
        <ChevronDown size={15} className={open ? 'flip' : ''} />
      </button>
      {open && (
        <ol className="hs-list">
          {[...events].reverse().map((e, i) => (
            <li key={i}>
              <div className="hs-when muted">
                {new Date(e.ts).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })} · {e.course || ''} · {runLabel(e.run)}
              </div>
              <div>
                <b>{e.title || ''}</b> {describe(e)}
              </div>
              {e.reason && <div className="hs-why">Why: {e.reason}</div>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
