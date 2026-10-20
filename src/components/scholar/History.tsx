// Why and when things changed: an item's history (from the engine's append-only record: created from which source,
// each change old → new, replaced or cancelled and why, which scan did it), and a "what changed" list for the week.
import { useEffect, useState } from 'react';
import { ChevronDown, History as HistoryIcon } from 'lucide-react';
import { api, HistoryEvent, ScholarCurriculum } from '../../lib/api';
import { toast } from '../../store';
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

function describe(e: HistoryEvent, only?: Set<string>): string {
  if (e.op === 'baseline') return e.reason || 'History starts here.';
  if (e.op === 'create') return 'Added to your calendar';
  if (e.op === 'source') return `Read a source: ${(e.changes as any)?.title || ''}`;
  if (e.op === 'unsync') return 'Taken off the synced calendar';
  if (e.op === 'dismiss') return 'Marked not separate work';
  const ch = (e.changes || {}) as Record<string, [unknown, unknown]>;
  const parts = Object.entries(ch)
    .filter(([k]) => k !== 'source_ids_json' && k !== 'superseded_by_id' && (!only || only.has(k)))
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

// Changes a student cares about: dates and times, names, kinds, points, added, removed, cancelled. Filling in links or
// instructions is bookkeeping and stays in each item's History.
const MEANINGFUL = new Set(['title', 'item_type', 'date', 'start_time', 'end_time', 'due_time', 'date_range_end', 'status', 'points', 'is_optional']);
const meaningful = (e: HistoryEvent) => {
  if (e.op === 'source' || e.op === 'baseline' || e.op === 'dismiss') return false;
  if (e.op !== 'update') return true;
  const ch = (e.changes || {}) as Record<string, [unknown, unknown]>;
  // (A status moving between Kea's own bookkeeping states, like "clear" to "synced", isn't a change to the calendar.)
  return Object.keys(ch).some((k) => MEANINGFUL.has(k) && !(k === 'status' && !['cancelled', 'superseded'].includes(String(ch[k]?.[1]))));
};

/**
 * "What changed": what was added, moved, renamed, replaced or cancelled on the calendar this week, and why. Each item
 * once (its latest change, with how many there were), grouped by class; Kea building its own reading weeks isn't news.
 */
export function ChangesBox() {
  const version = useScholar((s) => s.version);
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<(HistoryEvent & { title: string | null; course: string | null })[] | null>(null);
  useEffect(() => {
    api.scholar
      .changes({})
      .then((r) =>
        setEvents(
          r.events.filter((e) => {
            if (!((e.table === 'academic_items' || e.op === 'dismiss') && meaningful(e))) return false;
            const kind = (e.changes as any)?.item_type;
            return !(e.op === 'create' && (kind === 'weekly_reading' || (Array.isArray(kind) && kind[1] === 'weekly_reading')));
          })
        )
      )
      .catch(() => setEvents([]));
  }, [version]);
  if (!events || !events.length) return null;
  // The latest change to each item, and how many it had. An item added and taken off again this week (a duplicate
  // a check made and cleaned up) never reached the calendar as anything: it's left out.
  const byItem = new Map<string, { last: (typeof events)[number]; n: number; created: boolean }>();
  for (const e of events) {
    const k = e.id || `${e.course}|${e.title}`;
    const cur = byItem.get(k);
    byItem.set(k, { last: !cur || e.ts > cur.last.ts ? e : cur.last, n: (cur?.n || 0) + 1, created: !!cur?.created || e.op === 'create' });
  }
  for (const [k, x] of byItem) if (x.created && (x.last.op === 'supersede' || x.last.op === 'cancel')) byItem.delete(k);
  const groups = new Map<string, { last: (typeof events)[number]; n: number; created: boolean }[]>();
  for (const x of [...byItem.values()].sort((p, q) => q.last.ts.localeCompare(p.last.ts))) {
    const c = x.last.course || 'Other';
    groups.set(c, [...(groups.get(c) || []), x]);
  }
  const total = byItem.size;
  if (!total) return null;
  return (
    <section className="hs-changes">
      <button className="hs-head" onClick={() => setOpen(!open)}>
        <HistoryIcon size={15} /> <b>{total} calendar change{total === 1 ? '' : 's'} this week</b>
        <span className="muted">{[...groups].map(([c, list]) => `${c} ${list.length}`).join(' · ')}</span>
        <ChevronDown size={15} className={open ? 'flip' : ''} />
      </button>
      {open &&
        [...groups].map(([c, list]) => (
          <div key={c} className="hs-group">
            <div className="hs-group-head">{c}</div>
            <ol className="hs-list">
              {list.map(({ last: e, n }, i) => (
                <li key={i}>
                  <div className="hs-when muted">
                    {new Date(e.ts).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })} · {runLabel(e.run)}
                    {n > 1 ? ` · ${n} changes this week` : ''}
                  </div>
                  <div>
                    <b>{e.title || ''}</b> {describe(e, MEANINGFUL)}
                  </div>
                  {e.reason && <div className="hs-why">Why: {e.reason}</div>}
                </li>
              ))}
            </ol>
          </div>
        ))}
    </section>
  );
}

/** A class's rules (late work, required uploads, exam environment, participation), strongest first. */
export function ClassRules({ code }: { code: string }) {
  const [open, setOpen] = useState(false);
  const [rules, setRules] = useState<{ text: string; where: string }[] | null>(null);
  useEffect(() => {
    setRules(null);
    api.scholar
      .courseRules(code)
      .then((r) => setRules(r.rules))
      .catch(() => setRules([]));
  }, [code]);
  if (!rules || !rules.length) return null;
  return (
    <section className="hs-changes cls-rules">
      <button className="hs-head" onClick={() => setOpen(!open)}>
        <b>Class rules ({rules.length})</b>
        <span className="muted">what can cost points, from the syllabus and announcements</span>
        <ChevronDown size={15} className={open ? 'flip' : ''} />
      </button>
      {open && (
        <ul className="cls-rule-list">
          {rules.map((r, i) => (
            <li key={i}>
              {r.text} <span className="muted">({r.where})</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}


const KIND: Record<string, string> = { course: 'Course outcomes', module: 'Module outcomes', outline: 'Topical outline', recommended: 'Recommended topics' };

/**
 * The class's chapters against its syllabus: the textbook, every outcome and topical-outline item with the chapters
 * that teach it, the testing guidelines, and anything that doesn't match yet (which Kea's curriculum run fixes).
 */
export function SyllabusMap({ code }: { code: string }) {
  const [open, setOpen] = useState(false);
  const [cur, setCur] = useState<ScholarCurriculum | null>(null);
  const [busy, setBusy] = useState(false);
  const load = (fresh = false) =>
    api.scholar
      .curriculum(code, fresh)
      .then(setCur)
      .catch(() => setCur(null));
  useEffect(() => {
    setCur(null);
    load();
  }, [code]);
  if (!cur || (!cur.outcomes.length && !cur.problems.length)) return null;
  const gaps = cur.problems.filter((p) => p.severity === 'fix');
  // Chapters missing the same thing make one line ("Chapters 19, 22 and 23 have no sections.").
  const shownGaps = (() => {
    const same = new Map<string, string[]>();
    const rest: { key: string; text: string }[] = [];
    for (const g of gaps) {
      const m = /^(Chapter \d+|Module \d+|Unit \d+) has no (.+)\.$/.exec(g.text);
      if (m) same.set(m[2], [...(same.get(m[2]) || []), m[1]]);
      else rest.push(g);
    }
    const grouped = [...same].map(([what, labels]) => ({
      key: `missing:${what}`,
      text: labels.length === 1 ? `${labels[0]} has no ${what}.` : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]} have no ${what}.`
    }));
    return [...grouped, ...rest];
  })();
  const kinds = (['outline', 'recommended', 'module', 'course'] as const).filter((k) => cur.outcomes.some((o) => o.kind === k));
  const fix = async () => {
    setBusy(true);
    try {
      await api.scholar.run('curriculum', code);
      toast(`Kea is matching ${code}'s chapters to its syllabus.`, 'success');
    } catch (e) {
      toast(String((e as Error)?.message || e), 'error');
    } finally {
      setBusy(false);
    }
  };
  const depth = async () => {
    setBusy(true);
    try {
      await api.scholar.run('curriculum', `${code} depth`);
      toast(`Kea is checking ${code}'s chapters at exam depth, a few at a time.`, 'success');
    } catch (e) {
      toast(String((e as Error)?.message || e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="hs-changes cls-rules syl-map">
      <button className="hs-head" onClick={() => setOpen(!open)}>
        <b>Syllabus</b>
        <span className={gaps.length ? 'syl-chip warn' : 'syl-chip ok'}>{gaps.length ? `${gaps.length} to fix` : 'chapters match'}</span>
        <span className="muted">what the course must teach, and the chapters that teach it</span>
        <ChevronDown size={15} className={open ? 'flip' : ''} />
      </button>
      {open && (
        <div className="syl-body">
          {cur.textbook && (
            <p className="syl-book">
              {cur.textbook.none ? `No textbook (${cur.textbook.none}).` : <>Textbook: {cur.textbook.title}{cur.textbook.numbering === 'different' ? '. The class numbers chapters differently from the book: each chapter below says where it is in your book.' : '.'}</>}
            </p>
          )}
          {gaps.length > 0 && (
            <div className="syl-gaps">
              <ul>
                {shownGaps.slice(0, 12).map((g) => (
                  <li key={g.key}>{g.text}</li>
                ))}
                {shownGaps.length > 12 && <li className="muted">…and {shownGaps.length - 12} more</li>}
              </ul>
              <button className="btn sm" disabled={busy} onClick={fix}>
                Fix with a scan
              </button>
            </div>
          )}
          {kinds.map((k) => (
            <div key={k} className="syl-group">
              <div className="syl-kind">{KIND[k]}</div>
              <ul>
                {cur.outcomes
                  .filter((o) => o.kind === k)
                  .map((o) => (
                    <li key={o.ref} className={o.not_tested ? 'muted' : ''}>
                      <span className="syl-ref">{o.ref}</span> {o.text}{' '}
                      {o.not_tested ? (
                        <span className="muted">(not in study sets: {o.not_tested})</span>
                      ) : o.chapters.length ? (
                        <span className="syl-chs">{o.chapters.map((c) => (c === 'all' ? 'every chapter' : c.replace(/^Chapter /, 'Ch ').replace(/^Module /, 'Mod '))).join(', ')}</span>
                      ) : (
                        <span className="syl-chip warn">no chapter</span>
                      )}
                    </li>
                  ))}
              </ul>
            </div>
          ))}
          {cur.chapters.some((c) => c.textbook_ref) && (
            <div className="syl-group">
              <div className="syl-kind">Where each chapter is in your book</div>
              <ul>
                {cur.chapters
                  .filter((c) => c.textbook_ref)
                  .map((c) => (
                    <li key={c.label}>
                      <span className="syl-ref">{c.label.replace(/^Chapter /, 'Ch ')}</span> {c.textbook_ref}
                    </li>
                  ))}
              </ul>
            </div>
          )}
          {cur.guidelines.length > 0 && (
            <div className="syl-group">
              <div className="syl-kind">How the class tests (study sets follow these)</div>
              <ul>
                {cur.guidelines.map((g, i) => (
                  <li key={i}>{g.text}</li>
                ))}
              </ul>
            </div>
          )}
          {(() => {
            const done = cur.chapters.filter((c) => c.depth);
            const gapped = cur.chapters.filter((c) => c.depth === 'gaps');
            return (
              <div className="syl-group">
                <div className="syl-kind">Depth</div>
                <p className="syl-book">
                  {done.length
                    ? `${done.length} of ${cur.chapters.length} chapters checked at exam depth (textbook, notes and every question's explanation).${gapped.length ? ` ${gapped.map((c) => c.label).join(', ')} had gaps and ${gapped.length > 1 ? 'are' : 'is'} being rewritten.` : ''}`
                    : 'No chapter has had its depth checked yet: Kea reviews every chapter, starting with the ones tested soonest.'}
                </p>
                {gapped.length > 0 && (
                  <ul>
                    {gapped.map((c) => (
                      <li key={c.label}>
                        <span className="syl-ref">{c.label.replace(/^Chapter /, 'Ch ')}</span> {String(c.depth_note || '').slice(0, 300)}
                      </li>
                    ))}
                  </ul>
                )}
                <button className="btn sm" disabled={busy} onClick={depth}>
                  Check depth now
                </button>
              </div>
            );
          })()}
          <button className="btn sm ghost" onClick={() => load(true)}>
            Check again
          </button>
        </div>
      )}
    </section>
  );
}
