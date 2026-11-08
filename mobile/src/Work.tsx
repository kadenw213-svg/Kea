// The Work tab: my shifts from every organization (with swaps and availability forms), the time clock with today's
// status and a pay-code picker, my timecard, missed-punch and time-off requests, my pay, and to-dos. For people whose
// roles allow it: join requests, timecards, time off and swaps to approve, and simple shift changes. Each screen shows
// only for what the server says this person can do (me.abilities; the fixed role on a Kea Hub 0.5); the server checks
// again. While a server can't be reached the saved shifts and to-dos show, and clocking in says it needs a connection.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, ArrowLeftRight, Briefcase, CalendarClock, Check, ChevronLeft, ChevronRight, Clock3, LogIn, LogOut, Plus, RefreshCw, Trash2, Undo2, X } from 'lucide-react';
import { NeedsOnline, useAccount } from './NeedsOnline';
import { onAccountChange } from './hub';
import { can, parseJoin, renewSoon, startRenewal, useJoinLink, work, workAccount, workAreas, workReady, type ServerView, type WorkOrg } from './orgs';
import { toast, when } from './ui';
import { useBack } from './back';

// ---------- small helpers ----------
const errText = (e: any) => String(e?.message || e);
const pad = (n: number) => String(n).padStart(2, '0');
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (day: string, n: number) => {
  const [y, m, d] = day.split('-').map(Number);
  return isoDay(new Date(y, m - 1, d + n));
};
const today = () => isoDay(new Date());
const dayOf = (iso: string, tz: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: tz });
const time = (iso: string, tz: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone: tz });
const dayName = (day: string) => {
  if (day === today()) return 'Today';
  if (day === addDays(today(), 1)) return 'Tomorrow';
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
};
const shortDay = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
};
const hrs = (min: number) => `${Math.round((min / 60) * 100) / 100} h`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const money = (cents: number | null | undefined) => (cents == null ? null : (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD' }));
/** 'today 3:40 PM', 'yesterday', 'on Oct 12': when the saved copy was made. */
const savedWhen = (ms: number) => {
  const w = when(ms);
  return /^(Today|Yesterday)/.test(w) ? w.charAt(0).toLowerCase() + w.slice(1) : `on ${w}`;
};
const path = (o: WorkOrg, rest = '') => `/v1/orgs/${encodeURIComponent(o.id)}${rest}`;

/** One load, with reload; `key` reloads it when it changes. */
function useLoad<T>(fn: (() => Promise<T>) | null, key: unknown[]) {
  const [s, set] = useState<{ data: T | null; error: string | null; busy: boolean }>({ data: null, error: null, busy: !!fn });
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!fn) return set({ data: null, error: null, busy: false });
    let live = true;
    set((x) => ({ ...x, busy: true }));
    fn().then(
      (data) => live && set({ data, error: null, busy: false }),
      (e) => live && set((x) => ({ data: x.data, error: errText(e), busy: false }))
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...key, n]);
  return { ...s, reload: () => setN((x) => x + 1) };
}

/** A change sent to an organization: a short message after, or what went wrong. */
async function act<T = any>(o: WorkOrg, p: string, body: unknown, done?: string): Promise<T | null> {
  try {
    const r = await work.call(o.id, 'POST', p, body ?? {});
    if (done) toast(done);
    return r as T;
  } catch (e: any) {
    toast(e?.status === 0 ? `That needs a connection to ${o.name}.` : errText(e));
    return null;
  }
}
const get = <T,>(o: WorkOrg, p: string) => work.call(o.id, 'GET', p) as Promise<T>;

function Sheet({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  useBack(true, onClose);
  return (
    <div className="sheet-bg" onClick={onClose}>
      <div className="sheet work-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <b>{title}</b>
          <button className="icon" aria-label="Close" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ---------- the tab ----------
type View = 'shifts' | 'time' | 'pay' | 'todo' | 'manage';

export function WorkTab({ onAccount }: { onAccount(): void }) {
  const [acct] = useAccount();
  const [ready, setReady] = useState<{ usable: boolean } | null>(null);
  const [view, setView] = useState<View>('shifts');
  const [version, setVersion] = useState(0);
  const [joining, setJoining] = useState(false);
  const [link, clearLink] = useJoinLink();
  const [orgId, setOrgId] = useState<string | null>(null);
  const [state, setState] = useState<{ orgs: WorkOrg[]; servers: (ServerView & { offline?: boolean; error?: string | null })[]; offline: string[]; hubError: string | null; at: number | null } | null>(null);

  useEffect(() => {
    const check = () => void workReady().then(setReady, () => setReady({ usable: false }));
    check();
    return onAccountChange(check);
  }, []);
  useEffect(() => {
    if (link) setJoining(true);
  }, [link]);
  // (Another account signed in: nothing of the last one's stays on screen.)
  const who = acct?.account?.id ?? null;
  useEffect(() => {
    setState(null);
    setOrgId(null);
  }, [who]);
  useEffect(() => {
    if (!ready?.usable || !who) return;
    startRenewal();
    let live = true;
    // (The saved copy at once; then what the servers say.)
    const s = work.saved();
    if (s.orgs.length) setState((x) => x ?? ({ orgs: s.orgs, servers: [], offline: [], hubError: null, at: s.at }));
    workAccount()
      .then(() => work.orgs())
      .then((r) => live && setState(r))
      .catch((e) => live && toast(e));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready?.usable, version, who]);

  const refresh = () => {
    renewSoon(true);
    setVersion((v) => v + 1);
  };
  const orgs = state?.orgs ?? [];
  const offline = new Set(state?.offline ?? []);
  const manage = orgs.some((o) => workAreas(o).approvals || workAreas(o).editShifts);
  const pickable = view === 'manage' ? orgs.filter((o) => workAreas(o).approvals || workAreas(o).editShifts) : orgs;
  const org = pickable.find((o) => o.id === orgId) ?? pickable.find((o) => !offline.has(o.src)) ?? pickable[0] ?? null;

  if (!ready || !acct) return <div className="page" />;
  if (!ready.usable)
    return (
      <div className="page">
        <h1>Work</h1>
        {link && <p className="note">You opened a join link. Once your Kea account is online, it’s here to join.</p>}
        <NeedsOnline status={acct} what="Shifts, the time clock and your pay come from your organization" onOpen={onAccount} />
      </div>
    );

  const chips: [View, string][] = [
    ['shifts', 'Shifts'],
    ['time', 'Time'],
    ['pay', 'Pay'],
    ['todo', 'To do']
  ];
  if (manage) chips.push(['manage', 'Manage']);
  const needsOrg = view === 'time' || view === 'pay' || view === 'manage';
  // (Signed in on this phone only, or the account server can't be reached: one calm line about what waits for it.)
  const accountNote = acct.state !== 'online' || (!!state && state.offline.includes('hub'));

  return (
    <div className="page work">
      <div className="work-head">
        <h1>Work</h1>
        <button className="icon" aria-label="Refresh" onClick={refresh}>
          <RefreshCw size={18} />
        </button>
        <button className="btn small-btn" onClick={() => setJoining(true)}>
          <Plus size={15} /> Join
        </button>
      </div>
      <div className="chips wrap">
        {chips.map(([id, label]) => (
          <button key={id} className={view === id ? 'on' : ''} onClick={() => setView(id)}>
            {label}
          </button>
        ))}
      </div>
      {needsOrg && pickable.length > 1 && (
        <select className="input" value={org?.id ?? ''} onChange={(e) => setOrgId(e.target.value)} aria-label="Organization">
          {pickable.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      )}
      {accountNote && <NeedsOnline status={acct} compact what="Joining, and organizations on your Kea account" onOpen={onAccount} />}
      <ServerNotes state={state} onChanged={refresh} />
      {state && !orgs.length && (
        <div className="empty work-empty">
          <Briefcase size={28} />
          <p>No organizations yet. Join one with the code or link someone there gave you.</p>
          <button className="btn primary" onClick={() => setJoining(true)}>
            <Plus size={16} /> Join an organization
          </button>
        </div>
      )}
      {orgs.length > 0 && view === 'shifts' && <ShiftsView key={version} orgs={orgs} offline={offline} />}
      {orgs.length > 0 && view === 'todo' && <TodoView key={version} orgs={orgs} goto={setView} />}
      {org && view === 'time' && <TimeView key={`${org.id}-${version}`} org={org} offline={offline.has(org.src)} />}
      {org && view === 'pay' && <PayView key={`${org.id}-${version}`} org={org} offline={offline.has(org.src)} />}
      {org && view === 'manage' && <ManageView key={`${org.id}-${version}`} org={org} offline={offline.has(org.src)} />}
      {joining && (
        <JoinSheet
          initial={link}
          online={acct.state === 'online'}
          servers={state?.servers ?? []}
          onClose={() => (setJoining(false), clearLink())}
          onJoined={() => (setJoining(false), clearLink(), refresh())}
        />
      )}
    </div>
  );
}

/** Servers that signed this account out, can't be reached, or need online: one calm line each. */
function ServerNotes({ state, onChanged }: { state: { servers: (ServerView & { offline?: boolean; error?: string | null })[]; offline: string[]; hubError: string | null; at: number | null } | null; onChanged(): void }) {
  if (!state) return null;
  const out = state.servers.filter((s) => s.signedOut || s.error);
  const saved = state.offline.length > 0;
  return (
    <>
      {saved && <div className="stale">Showing what was saved{state.at ? ` ${savedWhen(state.at)}` : ''}. Kea tries again by itself.</div>}
      {state.hubError && <div className="stale">{state.hubError}</div>}
      {out.map((s) => (
        <div key={s.serverId} className="stale work-signed-out">
          <AlertTriangle size={14} />
          <span className="row-main">{s.signedOut ? `${s.name || 'This organization'} signed you out.` : `${s.name || 'An organization'}: ${s.error}`}</span>
          {s.signedOut && (
            <button className="btn small-btn" onClick={() => work.again(s.serverId).then(() => (toast('Signed in again.'), onChanged()), (e) => toast(e))}>
              Sign in again
            </button>
          )}
        </div>
      ))}
    </>
  );
}

// ---------- joining ----------
function JoinSheet({ initial, online, servers, onClose, onJoined }: { initial: string | null; online: boolean; servers: ServerView[]; onClose(): void; onJoined(): void }) {
  const [text, setText] = useState(initial ?? '');
  const [adv, setAdv] = useState(false);
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  let what: string | null = null;
  try {
    const p = text.trim() ? parseJoin(text) : null;
    what = p?.url ? `On ${p.url.replace(/^https:\/\//, '')}` : null;
  } catch {}
  const go = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await work.join(adv ? { address, code } : text);
      toast(r.pending ? r.message || 'Request sent. Your manager approves it.' : r.alreadyMember ? `You’re already in ${r.org?.name}.` : `You’re in: ${r.org?.name}.`);
      onJoined();
    } catch (e: any) {
      setMsg(e?.status === 0 ? `${errText(e)}` : errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title="Join an organization" onClose={onClose}>
      {!online && <p className="note">Joining needs your Kea account online. Sign in online under Settings → Kea account.</p>}
      {!adv ? (
        <label className="field">
          Join code or link
          <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="The code or kea://join link you were given" autoCapitalize="characters" autoCorrect="off" />
        </label>
      ) : (
        <>
          <label className="field">
            Server address
            <input className="input" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="https://name.example.org" autoCapitalize="none" autoCorrect="off" inputMode="url" />
          </label>
          <label className="field">
            Join code
            <input className="input" value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="characters" autoCorrect="off" />
          </label>
        </>
      )}
      {what && !adv && <p className="muted small">{what}</p>}
      {msg && <p className="note warn">{msg}</p>}
      <button className="btn primary" disabled={busy || !online || (adv ? !address.trim() || !code.trim() : !text.trim())} onClick={go}>
        {busy ? 'Joining…' : 'Join'}
      </button>
      <details className="why" open={adv} onToggle={(e) => setAdv((e.target as HTMLDetailsElement).open)}>
        <summary>Advanced</summary>
        <p className="muted small">Type the organization server’s address and the code separately. Kea checks that the server is who it says it is before it signs in.</p>
      </details>
      {servers.length > 0 && (
        <>
          <h2>Servers on this phone</h2>
          {servers.map((s) => (
            <div key={s.serverId} className="card">
              <span className="row-main">
                <b>{s.name || s.url.replace(/^https:\/\//, '')}</b>
                <span className="muted small block">{s.signedOut ? 'Signed you out' : s.url.replace(/^https:\/\//, '')}</span>
              </span>
              <button
                className="icon"
                aria-label="Remove"
                onClick={() => {
                  if (!window.confirm(`Remove ${s.name || 'this server'} from this phone? You can join again with a new code.`)) return;
                  work.remove(s.serverId).then(onJoined, (e) => toast(e));
                }}
              >
                <Trash2 size={18} />
              </button>
            </div>
          ))}
        </>
      )}
    </Sheet>
  );
}

// ---------- shifts, swaps, availability ----------
interface Shift {
  id: string;
  orgId: string;
  orgName: string;
  tz: string;
  src: string;
  positionName: string | null;
  start: string;
  end: string;
  startAt: number;
  endAt: number;
  note: string | null;
  swap?: { id: string; status: string } | null;
}
interface Swap {
  id: string;
  shiftId: string;
  from: string;
  fromName: string | null;
  claimant: string | null;
  claimantName: string | null;
  note: string | null;
  status: string;
  shift: Shift | null;
}

function ShiftsView({ orgs, offline }: { orgs: WorkOrg[]; offline: Set<string> }) {
  const shifts = useLoad(() => work.shifts(), []);
  const live = orgs.filter((o) => !offline.has(o.src));
  const swaps = useLoad(() => Promise.all(live.map((o) => get<{ swaps: Swap[] }>(o, path(o, '/swaps')).then((r) => r.swaps.map((w) => ({ ...w, org: o })), () => []))).then((x) => x.flat()), [live.map((o) => o.id).join()]);
  const forms = useLoad(() => Promise.all(live.map((o) => get<{ forms: any[] }>(o, path(o, '/forms')).then((r) => r.forms.filter((f) => f.status === 'open').map((f) => ({ ...f, org: o })), () => []))).then((x) => x.flat()), [live.map((o) => o.id).join()]);
  const [offer, setOffer] = useState<Shift | null>(null);
  const [form, setForm] = useState<{ org: WorkOrg; id: string } | null>(null);
  const reload = () => (shifts.reload(), swaps.reload());
  const byId = new Map(orgs.map((o) => [o.id, o]));
  const list = (shifts.data?.shifts ?? []) as Shift[];
  const groups = useMemo(() => {
    const m = new Map<string, Shift[]>();
    for (const s of list) {
      const d = dayOf(s.start, s.tz);
      m.set(d, [...(m.get(d) ?? []), s]);
    }
    return [...m.entries()];
  }, [list]);
  const mine = (o: WorkOrg | undefined) => o?.myId ?? null;
  const allSwaps = (swaps.data ?? []) as (Swap & { org: WorkOrg })[];
  const grabs = allSwaps.filter((w) => w.status === 'offered' && w.shift && w.from !== mine(w.org) && w.shift.startAt > Date.now());
  const waiting = allSwaps.filter((w) => w.status === 'claimed' && w.claimant === mine(w.org) && w.shift);
  const answer = ((forms.data ?? []) as any[]).filter((f) => !f.submittedAt);

  const claim = async (w: Swap & { org: WorkOrg }) => {
    const s = w.shift!;
    if (!window.confirm(`Take ${w.fromName ? `${w.fromName}’s` : 'this'} shift, ${shortDay(dayOf(s.start, w.org.tz))} ${time(s.start, w.org.tz)}–${time(s.end, w.org.tz)}?`)) return;
    const r = await act<{ swap: Swap }>(w.org, path(w.org, `/swaps/${w.id}/claim`), {});
    if (r) toast(r.swap.status === 'approved' ? 'The shift is yours.' : 'Taken. It’s yours once a manager approves.');
    reload();
  };
  return (
    <>
      {shifts.data?.saved && !offline.size && <div className="stale">Showing what was saved for some of your organizations.</div>}
      {shifts.error && !shifts.data && <p className="note warn">{shifts.error}</p>}
      {answer.map((f) => (
        <button key={`${f.org.id}-${f.id}`} className="card link" onClick={() => setForm({ org: f.org, id: f.id })}>
          <CalendarClock size={18} />
          <span className="row-main">
            <b>{f.title}</b>
            <span className="muted small block">
              {f.org.name} · Your availability{f.deadlineAt ? `, due ${when(f.deadlineAt)}` : ''}
            </span>
          </span>
          <span className="btn small-btn">Answer</span>
        </button>
      ))}
      {waiting.length > 0 && <h2>Waiting for a manager</h2>}
      {waiting.map((w) => (
        <div key={w.id} className="card">
          <span className="row-main">
            <b>
              {w.shift!.positionName ?? 'Shift'} · {shortDay(dayOf(w.shift!.start, w.org.tz))} {time(w.shift!.start, w.org.tz)}–{time(w.shift!.end, w.org.tz)}
            </b>
            <span className="muted small block">From {w.fromName ?? 'a coworker'}. It’s yours once a manager approves.</span>
          </span>
        </div>
      ))}
      {grabs.length > 0 && <h2>Up for grabs</h2>}
      {grabs.map((w) => (
        <div key={w.id} className="card">
          <span className="row-main">
            <b>
              {w.shift!.positionName ?? 'Shift'} · {shortDay(dayOf(w.shift!.start, w.org.tz))} {time(w.shift!.start, w.org.tz)}–{time(w.shift!.end, w.org.tz)}
            </b>
            <span className="muted small block">
              {w.org.name} · from {w.fromName ?? 'a coworker'}
              {w.note ? ` · “${w.note}”` : ''}
            </span>
          </span>
          <button className="btn small-btn primary" onClick={() => claim(w)}>
            Take it
          </button>
        </div>
      ))}
      {shifts.busy && !shifts.data && <p className="muted">Loading your shifts…</p>}
      {shifts.data && !list.length && <p className="empty">No shifts coming up. Published shifts show here.</p>}
      {groups.map(([d, items]) => (
        <section key={d}>
          <h2>{dayName(d)}</h2>
          {items.map((s) => {
            const o = byId.get(s.orgId);
            const sw = allSwaps.find((w) => w.shiftId === s.id && ['offered', 'claimed'].includes(w.status));
            const off = offline.has(s.src);
            return (
              <div key={`${s.orgId}-${s.id}`} className="card work-shift">
                <span className="row-main">
                  <b>
                    {time(s.start, s.tz)}–{time(s.end, s.tz)} · {s.positionName ?? 'Shift'}
                  </b>
                  <span className="muted small block">
                    {s.orgName}
                    {s.note ? ` · ${s.note}` : ''}
                    {sw ? ` · ${sw.status === 'claimed' ? `${allSwaps.find((w) => w.id === sw.id)?.claimantName ?? 'Someone'} is taking it` : 'Offered'}` : ''}
                  </span>
                </span>
                {!off && o && sw && (
                  <button className="icon" aria-label="Take back" onClick={() => act(o, path(o, `/swaps/${sw.id}/cancel`), {}, 'It’s yours again.').then(reload)}>
                    <Undo2 size={18} />
                  </button>
                )}
                {!off && o && !sw && s.startAt > Date.now() && (
                  <button className="btn small-btn" onClick={() => setOffer(s)}>
                    <ArrowLeftRight size={14} /> Swap
                  </button>
                )}
              </div>
            );
          })}
        </section>
      ))}
      {offer && byId.get(offer.orgId) && <OfferSheet org={byId.get(offer.orgId)!} shift={offer} onClose={() => setOffer(null)} onDone={() => (setOffer(null), reload())} />}
      {form && <FormSheet org={form.org} formId={form.id} onClose={() => setForm(null)} onDone={() => (setForm(null), forms.reload())} />}
    </>
  );
}

function OfferSheet({ org, shift, onClose, onDone }: { org: WorkOrg; shift: Shift; onClose(): void; onDone(): void }) {
  const [note, setNote] = useState('');
  return (
    <Sheet title="Offer this shift" onClose={onClose}>
      <p>
        {shortDay(dayOf(shift.start, org.tz))} · {time(shift.start, org.tz)}–{time(shift.end, org.tz)} · {shift.positionName ?? 'Shift'}
      </p>
      <p className="muted small">It stays yours until someone takes it{org.settings?.swapNeedsApproval === false ? '' : ' and a manager approves'}.</p>
      <label className="field">
        A note for whoever takes it (optional)
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
      </label>
      <button className="btn primary" onClick={() => act(org, path(org, `/shifts/${shift.id}/swap`), { note: note.trim() || null }, 'Offered.').then((r) => r && onDone())}>
        Offer it
      </button>
    </Sheet>
  );
}

const ANSWERS: [string, string][] = [
  ['A', 'Yes'],
  ['I', 'If needed'],
  ['N', 'No']
];
/** An availability form: each block Yes / If needed / No, and a note. */
function FormSheet({ org, formId, onClose, onDone }: { org: WorkOrg; formId: string; onClose(): void; onDone(): void }) {
  const f = useLoad(() => get<any>(org, path(org, `/forms/${formId}`)), [formId]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!f.data) return;
    setAnswers({ ...(f.data.prefill?.usual ?? {}), ...(f.data.response?.answers ?? {}) });
    setNote(f.data.response?.note ?? '');
  }, [f.data]);
  const slots: any[] = f.data?.slots ?? [];
  const canEdit = f.data?.state?.canEdit !== false || f.data?.state?.changeRequest;
  const send = async () => {
    setBusy(true);
    const r = await act<{ status: string }>(org, path(org, `/forms/${formId}/response`), { answers, note: note.trim() || null, submit: true });
    setBusy(false);
    if (r) {
      toast(r.status === 'change_requested' ? 'Sent. Your manager looks at the change.' : 'Sent.');
      onDone();
    }
  };
  return (
    <Sheet title={f.data?.form?.title ?? 'Availability'} onClose={onClose}>
      {f.error && <p className="note warn">{f.error}</p>}
      {!f.data && !f.error && <p className="muted">Loading…</p>}
      {f.data && (
        <>
          <p className="muted small">When can you work? {f.data.state?.changeRequest ? 'The deadline has passed, so your manager looks at changes.' : ''}</p>
          {slots.map((s) => (
            <div key={s.key} className="work-slot">
              <span className="row-main">
                <b>{shortDay(s.date)}</b> <span className="muted small">{s.label || `${s.start}–${s.end}`}</span>
              </span>
              <div className="chips">
                {ANSWERS.map(([v, label]) => (
                  <button key={v} disabled={!canEdit} className={answers[s.key] === v ? 'on' : ''} onClick={() => setAnswers({ ...answers, [s.key]: v })}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <label className="field">
            A note (optional)
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
          </label>
          <button className="btn primary" disabled={busy || !canEdit} onClick={send}>
            Send
          </button>
        </>
      )}
    </Sheet>
  );
}

// ---------- the time clock, timecard, missed punches, time off ----------
interface PayCode {
  id: string;
  name: string;
  color?: string | null;
  default?: boolean;
  rateCents?: number;
}
interface MyPay {
  period: { start: string; end: string };
  current: { start: string; end: string };
  codes: PayCode[];
  defaultCodeId: string | null;
  hours: { codeId: string | null; name: string | null; rateCents: number | null; minutes: number; hours: number; noLongerGiven?: boolean }[];
  totals: { workedMin: number; regularMin: number; overtimeMin: number; doubleTimeMin: number };
  approved: unknown;
  note?: string;
  stubs?: { id?: string; periodStart?: string; periodEnd?: string; payDate?: string; netCents?: number; grossCents?: number; url?: string }[];
}

function ClockCard({ org, offline }: { org: WorkOrg; offline: boolean }) {
  const st = useLoad(() => get<{ clockedIn: boolean; punch: { at: string; payCodeId?: string | null } | null; canClock: boolean; defaultPayCodeId?: string | null }>(org, path(org, '/clock')), [org.id]);
  const todayShifts = useLoad(() => get<{ shifts: { shiftId: string; accountId: string; positionName: string | null; start: string; end: string; state: string; minutesLate: number }[] }>(org, path(org, '/clock/today')), [org.id]);
  const pay = useLoad(() => get<MyPay>(org, path(org, '/me/pay')).catch(() => null), [org.id]);
  const [code, setCode] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const codes = (pay.data?.codes ?? []).filter((c: any) => c.active !== false);
  useEffect(() => {
    if (!code && (st.data?.defaultPayCodeId || pay.data?.defaultCodeId)) setCode(st.data?.defaultPayCodeId || pay.data?.defaultCodeId || '');
  }, [st.data, pay.data]);
  if (offline || st.error) {
    const unreachable = offline || /reach|connection/i.test(st.error || '');
    return (
      <div className="card work-clock">
        <Clock3 size={20} />
        <span className="row-main">
          <b>Time clock</b>
          <span className="muted small block">{unreachable ? `Clocking in needs a connection to ${org.name}.` : st.error}</span>
        </span>
      </div>
    );
  }
  if (!st.data) return <p className="muted">Loading the time clock…</p>;
  if (!st.data.canClock) return null;
  const mine = (todayShifts.data?.shifts ?? []).filter((s) => s.accountId === org.myId);
  const next = mine.find((s) => s.state === 'upcoming' || s.state === 'late') ?? mine[0] ?? null;
  const since = st.data.clockedIn && st.data.punch ? time(st.data.punch.at, org.tz) : null;
  const go = async () => {
    setBusy(true);
    const type = st.data!.clockedIn ? 'out' : 'in';
    try {
      const r: any = await work.clock(org.id, type, code || null);
      toast(type === 'out' ? 'Clocked out.' : r?.late ? `Clocked in, ${r.minutesLate} min late.` : 'Clocked in.');
      st.reload();
      todayShifts.reload();
    } catch (e) {
      toast(e);
    } finally {
      setBusy(false);
    }
  };
  const codeName = (id?: string | null) => codes.find((c) => c.id === id)?.name;
  return (
    <div className="card work-clock">
      <Clock3 size={20} />
      <span className="row-main">
        <b>{since ? `Clocked in since ${since}` : 'Not clocked in'}</b>
        <span className="muted small block">
          {next ? `${next.positionName ?? 'Shift'} ${time(next.start, org.tz)}–${time(next.end, org.tz)}${next.state === 'late' && !since ? ` · ${next.minutesLate} min past start` : ''}` : 'No shift today'}
          {since && codeName(st.data.punch?.payCodeId) ? ` · ${codeName(st.data.punch?.payCodeId)}` : ''}
        </span>
        {!st.data.clockedIn && codes.length > 1 && (
          <select className="input work-code" value={code} onChange={(e) => setCode(e.target.value)} aria-label="Pay code">
            {codes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
      </span>
      <button className={`btn ${st.data.clockedIn ? '' : 'primary'}`} disabled={busy} onClick={go}>
        {st.data.clockedIn ? <LogOut size={16} /> : <LogIn size={16} />} {st.data.clockedIn ? 'Clock out' : 'Clock in'}
      </button>
    </div>
  );
}

/** Pay periods back and forward from the one the server sent (they're all the same length). */
function usePeriod(initial: { start: string; end: string } | null) {
  const [start, setStart] = useState<string | null>(null);
  const len = initial ? Math.round((Date.parse(initial.end) - Date.parse(initial.start)) / 864e5) + 1 : 14;
  const cur = start ?? initial?.start ?? null;
  return { start: cur, end: cur ? addDays(cur, len - 1) : null, prev: () => cur && setStart(addDays(cur, -len)), next: () => cur && setStart(addDays(cur, len)) };
}
function PeriodNav({ p }: { p: ReturnType<typeof usePeriod> }) {
  if (!p.start || !p.end) return null;
  return (
    <div className="work-period">
      <button className="icon" aria-label="Earlier pay period" onClick={p.prev}>
        <ChevronLeft size={18} />
      </button>
      <span>
        {shortDay(p.start)} – {shortDay(p.end)}
      </span>
      <button className="icon" aria-label="Later pay period" onClick={p.next}>
        <ChevronRight size={18} />
      </button>
    </div>
  );
}

function TimeView({ org, offline }: { org: WorkOrg; offline: boolean }) {
  const a = workAreas(org);
  return (
    <>
      {a.clock && <ClockCard org={org} offline={offline} />}
      {!offline && <MyTimecard org={org} />}
      {!offline && a.clock && <MissedPunch org={org} />}
      {!offline && <MyTimeOff org={org} />}
      {offline && <p className="muted small">Your timecard and requests show when {org.name} can be reached.</p>}
    </>
  );
}

function MyTimecard({ org }: { org: WorkOrg }) {
  const st = useLoad(() => get<{ period: { start: string; end: string } }>(org, path(org, '/clock')), [org.id]);
  const p = usePeriod(st.data?.period ?? null);
  const tc = useLoad(p.start ? () => get<any>(org, path(org, `/timecards?periodStart=${p.start}`)) : null, [org.id, p.start]);
  return (
    <>
      <h2>My timecard</h2>
      <PeriodNav p={p} />
      {tc.error && <p className="note warn">{tc.error}</p>}
      {tc.data && (
        <div className="card work-tc">
          <div className="row-main">
            {(tc.data.days as any[])
              .filter((d) => d.punches.length)
              .map((d) => (
                <div key={d.date} className="work-tc-day">
                  <span>{shortDay(d.date)}</span>
                  <span className="muted small">{d.punches.map((x: any) => `${x.type === 'in' ? 'In' : 'Out'} ${time(x.at, org.tz)}${String(x.source).startsWith('request:') ? ' (fixed)' : ''}`).join(' · ')}</span>
                  <b>{d.workedMin ? hrs(d.workedMin) : ''}</b>
                </div>
              ))}
            {!(tc.data.days as any[]).some((d) => d.punches.length) && <p className="muted small">No punches in this pay period.</p>}
            <p className="small">
              <b>{hrs(tc.data.totals.workedMin)}</b> worked{tc.data.totals.overtimeMin ? `, ${hrs(tc.data.totals.overtimeMin)} overtime` : ''}
              {tc.data.approved ? ' · Approved' : ''}
              {tc.data.pendingRequests ? ` · ${tc.data.pendingRequests} fix${tc.data.pendingRequests === 1 ? '' : 'es'} waiting` : ''}
            </p>
          </div>
        </div>
      )}
    </>
  );
}

const REASONS: [string, string][] = [
  ['forgot', 'I forgot to clock'],
  ['device', 'The clock didn’t work'],
  ['early_late_fix', 'Fix a punch that was early or late'],
  ['other', 'Something else']
];
/** "I forgot to clock out": a request for a manager to add the punch to one of my shifts. */
function MissedPunch({ org }: { org: WorkOrg }) {
  const from = useMemo(() => new Date(Date.now() - 3 * 864e5).toISOString(), []);
  const to = useMemo(() => new Date(Date.now() + 864e5).toISOString(), []);
  const shifts = useLoad(() => get<{ shifts: Shift[] }>(org, path(org, `/my-shifts?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)), [org.id]);
  const reqs = useLoad(() => get<{ requests: any[] }>(org, path(org, '/punch-requests')), [org.id]);
  const [open, setOpen] = useState(false);
  const [shiftId, setShiftId] = useState('');
  const [type, setType] = useState<'in' | 'out'>('out');
  const [at, setAt] = useState('');
  const [reason, setReason] = useState('forgot');
  const [note, setNote] = useState('');
  const past = (shifts.data?.shifts ?? []).filter((s) => s.startAt <= Date.now());
  const mine = (reqs.data?.requests ?? []).filter((r) => r.accountId === org.myId).slice(0, 5);
  const local = (iso: string) => {
    const d = new Date(iso);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };
  const pick = (id: string, t = type) => {
    setShiftId(id);
    const s = past.find((x) => x.id === id);
    if (s) setAt(local(t === 'in' ? s.start : s.end));
  };
  const send = async () => {
    if (await act(org, path(org, '/punch-requests'), { shiftId, type, at: new Date(at).toISOString(), reasonCode: reason, note: note.trim() || null }, 'Sent. Your manager fixes it.')) {
      setOpen(false);
      setNote('');
      reqs.reload();
    }
  };
  return (
    <>
      <h2>
        Missed a punch?
        {!open && (
          <button className="btn small-btn work-h-btn" onClick={() => setOpen(true)}>
            Ask for a fix
          </button>
        )}
      </h2>
      {open &&
        (!past.length ? (
          <p className="muted small">No shifts of yours in the last three days.</p>
        ) : (
          <div className="card work-form">
            <label className="field">
              Shift
              <select className="input" value={shiftId} onChange={(e) => pick(e.target.value)}>
                <option value="">Pick a shift…</option>
                {past.map((s) => (
                  <option key={s.id} value={s.id}>
                    {shortDay(dayOf(s.start, org.tz))} · {s.positionName ?? 'Shift'} {time(s.start, org.tz)}–{time(s.end, org.tz)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Missing
              <select className="input" value={type} onChange={(e) => (setType(e.target.value as 'in' | 'out'), shiftId && pick(shiftId, e.target.value as 'in' | 'out'))}>
                <option value="in">Clocking in</option>
                <option value="out">Clocking out</option>
              </select>
            </label>
            <label className="field">
              When
              <input className="input" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
            </label>
            <label className="field">
              Why
              <select className="input" value={reason} onChange={(e) => setReason(e.target.value)}>
                {REASONS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <input className="input" placeholder={reason === 'other' ? 'Say what happened' : 'A note (optional)'} value={note} onChange={(e) => setNote(e.target.value)} />
            <div className="actions">
              <button className="btn" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button className="btn primary" disabled={!shiftId || !at || (reason === 'other' && !note.trim())} onClick={send}>
                Send
              </button>
            </div>
          </div>
        ))}
      {!open && !mine.length && <p className="muted small">Forgot to clock in or out? Ask here, and your manager adds it to your timecard.</p>}
      {mine.map((r) => (
        <div key={r.id} className="card">
          <span className="row-main">
            <b>
              {r.type === 'in' ? 'Clock in' : 'Clock out'} at {time(r.at, org.tz)}, {shortDay(dayOf(r.at, org.tz))}
            </b>
            <span className="muted small block">{r.status === 'pending' ? 'Waiting for your manager' : r.status === 'approved' ? 'Fixed' : 'Not approved'}</span>
          </span>
        </div>
      ))}
    </>
  );
}

function MyTimeOff({ org }: { org: WorkOrg }) {
  const data = useLoad(() => get<{ timeOff: any[]; kinds: string[] }>(org, path(org, '/time-off')), [org.id]);
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState('vacation');
  const [start, setStart] = useState(addDays(today(), 7));
  const [end, setEnd] = useState(addDays(today(), 7));
  const [hours, setHours] = useState('');
  if (data.error) return null;
  const mine = (data.data?.timeOff ?? []).filter((t) => t.accountId === org.myId && t.status !== 'cancelled');
  const ask = can(org, 'timeoff.request');
  if (!ask && !mine.length) return null;
  const send = async () => {
    if (await act(org, path(org, '/time-off'), { kind, startDate: start, endDate: end < start ? start : end, hours: hours ? Number(hours) : null }, 'Asked. Your manager decides.')) {
      setOpen(false);
      data.reload();
    }
  };
  return (
    <>
      <h2>
        Time off
        {ask && !open && (
          <button className="btn small-btn work-h-btn" onClick={() => setOpen(true)}>
            Ask for time off
          </button>
        )}
      </h2>
      {open && (
        <div className="card work-form">
          <label className="field">
            Kind
            <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
              {(data.data?.kinds ?? ['vacation', 'sick', 'personal']).map((k) => (
                <option key={k} value={k}>
                  {cap(k)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            First day
            <input className="input" type="date" value={start} onChange={(e) => (setStart(e.target.value), end < e.target.value && setEnd(e.target.value))} />
          </label>
          <label className="field">
            Last day
            <input className="input" type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} />
          </label>
          <details className="why">
            <summary>Advanced</summary>
            <label className="field">
              Hours (only when it isn’t whole days)
              <input className="input" type="number" min={0} step={0.25} value={hours} onChange={(e) => setHours(e.target.value)} />
            </label>
          </details>
          <div className="actions">
            <button className="btn" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className="btn primary" onClick={send}>
              Ask
            </button>
          </div>
        </div>
      )}
      {!open && !mine.length && <p className="muted small">Nothing asked for.</p>}
      {mine.map((t) => (
        <div key={t.id} className="card">
          <span className="row-main">
            <b>
              {cap(t.kind)}: {shortDay(t.startDate)}
              {t.endDate !== t.startDate ? ` – ${shortDay(t.endDate)}` : ''}
            </b>
            <span className="muted small block">{t.status === 'pending' ? 'Waiting for your manager' : t.status === 'approved' ? 'Approved' : 'Not approved'}</span>
          </span>
          {(t.status === 'pending' || (t.status === 'approved' && t.startDate > today())) && (
            <button className="btn small-btn" onClick={() => act(org, path(org, `/time-off/${t.id}/cancel`), {}, 'Taken back.').then(data.reload)}>
              Take back
            </button>
          )}
        </div>
      ))}
    </>
  );
}

// ---------- my pay ----------
function PayView({ org, offline }: { org: WorkOrg; offline: boolean }) {
  const first = useLoad(offline ? null : () => get<MyPay>(org, path(org, '/me/pay')), [org.id, offline]);
  const p = usePeriod(first.data?.period ?? null);
  const moved = !!p.start && !!first.data && p.start !== first.data.period.start;
  const other = useLoad(moved ? () => get<MyPay>(org, path(org, `/me/pay?periodStart=${p.start}`)) : null, [org.id, p.start, moved]);
  const d = moved ? other.data : first.data;
  const error = moved ? other.error : first.error;
  if (offline) return <p className="muted">Your pay shows when {org.name} can be reached.</p>;
  if (error && /Not found/.test(error)) return <p className="muted">{org.name}’s server doesn’t show pay yet.</p>;
  return (
    <>
      {error && <p className="note warn">{error}</p>}
      {!d && !error && <p className="muted">Loading your pay…</p>}
      {d && (
        <>
          <h2>My pay codes</h2>
          {!d.codes.length && <p className="muted small">No pay codes given to you yet.</p>}
          {d.codes.map((c) => (
            <div key={c.id} className="card">
              <span className="row-main">
                <b>
                  {c.color && <i className="work-dot" style={{ background: c.color }} />}
                  {c.name}
                </b>
                {c.default && <span className="muted small block">Your usual code</span>}
              </span>
              {money(c.rateCents) && <span>{money(c.rateCents)}/h</span>}
            </div>
          ))}
          <h2>Hours</h2>
          <PeriodNav p={p} />
          <div className="card">
            <div className="row-main">
              {d.hours.map((h) => (
                <div key={h.codeId ?? 'none'} className="work-tc-day">
                  <span>{h.name ?? 'No code'}</span>
                  <span className="muted small">{h.noLongerGiven ? 'No longer yours' : money(h.rateCents) ? `${money(h.rateCents)}/h` : ''}</span>
                  <b>{hrs(h.minutes)}</b>
                </div>
              ))}
              {!d.hours.length && <p className="muted small">No hours in this pay period.</p>}
              <p className="small">
                <b>{hrs(d.totals.workedMin)}</b> worked
                {d.totals.overtimeMin ? `, ${hrs(d.totals.overtimeMin)} overtime` : ''}
                {d.totals.doubleTimeMin ? `, ${hrs(d.totals.doubleTimeMin)} double time` : ''}
                {d.approved ? ' · Approved' : ''}
              </p>
            </div>
          </div>
          <h2>Pay stubs</h2>
          {d.stubs?.length ? (
            d.stubs.map((s, i) => (
              <div key={s.id ?? i} className="card">
                <span className="row-main">
                  <b>{s.payDate ? shortDay(s.payDate) : s.periodEnd ? shortDay(s.periodEnd) : 'Pay stub'}</b>
                  {s.periodStart && s.periodEnd && (
                    <span className="muted small block">
                      {shortDay(s.periodStart)} – {shortDay(s.periodEnd)}
                    </span>
                  )}
                </span>
                {money(s.netCents) && <span>{money(s.netCents)}</span>}
              </div>
            ))
          ) : (
            <p className="muted small">{d.note || 'Pay stubs come from payroll. Ask your payroll admin for them.'}</p>
          )}
        </>
      )}
    </>
  );
}

// ---------- to-dos ----------
function TodoView({ orgs, goto }: { orgs: WorkOrg[]; goto(v: View): void }) {
  const t = useLoad(() => work.todo(), []);
  const [form, setForm] = useState<{ org: WorkOrg; id: string } | null>(null);
  const byId = new Map(orgs.map((o) => [o.id, o]));
  const items = t.data?.items ?? [];
  const run = async (it: any) => {
    const o = byId.get(it.orgId);
    const a = it.action || {};
    if (a.type === 'form' && o && a.formId) return setForm({ org: o, id: a.formId });
    if (a.type === 'ack' && o && a.policyId) {
      if (await act(o, path(o, `/policies/${a.policyId}/ack`), {}, 'Marked as read.')) t.reload();
      return;
    }
    if (a.type === 'swap') return goto('shifts');
    if (['approvals', 'schedule', 'formPeople'].includes(a.type)) return goto('manage');
    toast('Open it in Kea on your computer.');
  };
  return (
    <>
      {t.data?.saved && <div className="stale">Showing what was saved{t.data.at ? ` ${savedWhen(t.data.at)}` : ''}.</div>}
      {t.error && !t.data && <p className="note warn">{t.error}</p>}
      {t.busy && !t.data && <p className="muted">Loading…</p>}
      {t.data && !items.length && <p className="empty">Nothing to do right now.</p>}
      {items.map((it: any) => (
        <button key={it.key} className={`card link ${it.overdue ? 'work-overdue' : ''}`} onClick={() => run(it)}>
          <Check size={18} />
          <span className="row-main">
            <b>{it.title}</b>
            <span className="muted small block">
              {it.orgName}
              {it.detail ? ` · ${it.detail}` : ''}
              {it.dueAt ? ` · due ${when(it.dueAt)}` : ''}
            </span>
          </span>
        </button>
      ))}
      {form && <FormSheet org={form.org} formId={form.id} onClose={() => setForm(null)} onDone={() => (setForm(null), t.reload())} />}
    </>
  );
}

// ---------- approvals and shift changes (only what this person's roles allow) ----------
function ManageView({ org, offline }: { org: WorkOrg; offline: boolean }) {
  const a = workAreas(org);
  const [tab, setTab] = useState<'approve' | 'schedule'>(a.approvals ? 'approve' : 'schedule');
  if (offline) return <p className="muted">Approvals and shift changes need a connection to {org.name}.</p>;
  return (
    <>
      {a.approvals && (a.editShifts || a.teamSchedule) && (
        <div className="chips">
          <button className={tab === 'approve' ? 'on' : ''} onClick={() => setTab('approve')}>
            Approvals
          </button>
          <button className={tab === 'schedule' ? 'on' : ''} onClick={() => setTab('schedule')}>
            Schedule
          </button>
        </div>
      )}
      {tab === 'approve' && a.approvals ? <Approvals org={org} /> : <TeamSchedule org={org} />}
    </>
  );
}

function Approvals({ org }: { org: WorkOrg }) {
  const a = workAreas(org);
  const members = useLoad(a.approveJoins ? () => get<{ pending: any[] }>(org, path(org, '/members')) : null, [org.id]);
  const period = useLoad(a.approveTimecards ? () => get<{ period: { start: string; end: string }; people: any[] }>(org, path(org, '/timecards/period')) : null, [org.id]);
  const punches = useLoad(a.approveTimecards ? () => get<{ requests: any[] }>(org, path(org, '/punch-requests?status=pending')) : null, [org.id]);
  const off = useLoad(a.decideTimeOff ? () => get<{ timeOff: any[] }>(org, path(org, '/time-off?status=pending')) : null, [org.id]);
  const swaps = useLoad(a.decideSwaps ? () => get<{ swaps: Swap[] }>(org, path(org, '/swaps')) : null, [org.id]);
  const joins = members.data?.pending ?? [];
  const cards = (period.data?.people ?? []).filter((x) => !x.approved && !x.mine && x.workedMin > 0);
  const fixes = (punches.data?.requests ?? []).filter((r) => r.accountId !== org.myId);
  const offs = (off.data?.timeOff ?? []).filter((t) => t.accountId !== org.myId);
  const claimed = (swaps.data?.swaps ?? []).filter((w) => w.status === 'claimed' && w.shift);
  const nothing = !joins.length && !cards.length && !fixes.length && !offs.length && !claimed.length;
  const loading = [members, period, punches, off, swaps].some((x) => x.busy);
  const err = [members, period, punches, off, swaps].map((x) => x.error).find(Boolean);
  const Decide = ({ yes, no }: { yes(): void; no(): void }) => (
    <span className="work-decide">
      <button className="icon" aria-label="Decline" onClick={no}>
        <X size={18} />
      </button>
      <button className="btn small-btn primary" onClick={yes}>
        Approve
      </button>
    </span>
  );
  return (
    <>
      {err && <p className="note warn">{err}</p>}
      {loading && nothing && <p className="muted">Loading…</p>}
      {!loading && nothing && !err && <p className="empty">Nothing waiting for you.</p>}
      {joins.length > 0 && <h2>Asking to join</h2>}
      {joins.map((m) => (
        <div key={m.id} className="card">
          <span className="row-main">
            <b>{m.name}</b>
            <span className="muted small block">
              {m.email ?? ''}
              {m.emailVerified === false ? ' · email not verified' : ''}
            </span>
          </span>
          <Decide
            yes={() => act(org, path(org, `/members/${m.id}/approve`), { approve: true }, `${m.name} is in.`).then(members.reload)}
            no={() => window.confirm(`Decline ${m.name}?`) && act(org, path(org, `/members/${m.id}/approve`), { approve: false }, 'Declined.').then(members.reload)}
          />
        </div>
      ))}
      {cards.length > 0 && period.data && (
        <h2>
          Timecards · {shortDay(period.data.period.start)} – {shortDay(period.data.period.end)}
        </h2>
      )}
      {cards.map((x) => (
        <div key={x.accountId} className="card">
          <span className="row-main">
            <b>{x.name}</b>
            <span className="muted small block">
              {hrs(x.workedMin)}
              {x.overtimeMin ? `, ${hrs(x.overtimeMin)} overtime` : ''}
              {x.flags ? ` · ${x.flags} to look at` : ''}
              {x.pendingRequests ? ` · ${x.pendingRequests} fix${x.pendingRequests === 1 ? '' : 'es'} waiting` : ''}
            </span>
          </span>
          <button className="btn small-btn primary" onClick={() => act(org, path(org, '/timecards/approve'), { accountId: x.accountId, periodStart: period.data!.period.start }, 'Approved.').then(period.reload)}>
            Approve
          </button>
        </div>
      ))}
      {fixes.length > 0 && <h2>Missed punches</h2>}
      {fixes.map((r) => (
        <div key={r.id} className="card">
          <span className="row-main">
            <b>{r.name ?? 'Someone'}</b>
            <span className="muted small block">
              {r.type === 'in' ? 'Clock in' : 'Clock out'} at {time(r.at, org.tz)}, {shortDay(dayOf(r.at, org.tz))}
              {r.note ? ` · “${r.note}”` : ''}
            </span>
          </span>
          <Decide
            yes={() => act(org, path(org, `/punch-requests/${r.id}/decide`), { approve: true }, 'Fixed on their timecard.').then(() => (punches.reload(), period.reload()))}
            no={() => act(org, path(org, `/punch-requests/${r.id}/decide`), { approve: false }, 'Not approved.').then(punches.reload)}
          />
        </div>
      ))}
      {offs.length > 0 && <h2>Time off</h2>}
      {offs.map((t) => (
        <div key={t.id} className="card">
          <span className="row-main">
            <b>{t.name ?? 'Someone'}</b>
            <span className="muted small block">
              {cap(t.kind)}: {shortDay(t.startDate)}
              {t.endDate !== t.startDate ? ` – ${shortDay(t.endDate)}` : ''}
              {t.hours ? ` · ${t.hours} h` : ''}
            </span>
          </span>
          <Decide yes={() => act(org, path(org, `/time-off/${t.id}/decide`), { approve: true }, 'Approved.').then(off.reload)} no={() => act(org, path(org, `/time-off/${t.id}/decide`), { approve: false }, 'Not approved.').then(off.reload)} />
        </div>
      ))}
      {claimed.length > 0 && <h2>Swaps</h2>}
      {claimed.map((w) => (
        <div key={w.id} className="card">
          <span className="row-main">
            <b>
              {w.claimantName ?? 'Someone'} takes {w.fromName ?? 'a coworker'}’s shift
            </b>
            <span className="muted small block">
              {w.shift!.positionName ?? 'Shift'} · {shortDay(dayOf(w.shift!.start, org.tz))} {time(w.shift!.start, org.tz)}–{time(w.shift!.end, org.tz)}
            </span>
          </span>
          <Decide yes={() => act(org, path(org, `/swaps/${w.id}/decide`), { approve: true }, 'Approved.').then(swaps.reload)} no={() => act(org, path(org, `/swaps/${w.id}/decide`), { approve: false }, 'Not approved.').then(swaps.reload)} />
        </div>
      ))}
    </>
  );
}

interface TeamShift extends Shift {
  accountId: string | null;
  name: string | null;
  date: string;
  scheduleId: string | null;
  departmentId: string | null;
  status: string;
}
/** A week of everyone's shifts; tapping one (with schedule.edit) changes who has it or when. */
function TeamSchedule({ org }: { org: WorkOrg }) {
  const [start, setStart] = useState(today());
  const [edit, setEdit] = useState<TeamShift | null>(null);
  const from = new Date(`${start}T00:00:00`).toISOString();
  const to = new Date(`${addDays(start, 7)}T00:00:00`).toISOString();
  const sched = useLoad(() => get<{ shifts: TeamShift[] }>(org, path(org, `/schedule?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)), [org.id, start]);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  // (Anywhere it's given; the server refuses a shift outside the departments this person may change.)
  const editable = (_s: TeamShift) => can(org, 'schedule.edit');
  return (
    <>
      <div className="work-period">
        <button className="icon" aria-label="Earlier" onClick={() => setStart(addDays(start, -7))}>
          <ChevronLeft size={18} />
        </button>
        <span>
          {shortDay(days[0])} – {shortDay(days[6])}
        </span>
        <button className="icon" aria-label="Later" onClick={() => setStart(addDays(start, 7))}>
          <ChevronRight size={18} />
        </button>
      </div>
      {sched.error && <p className="note warn">{sched.error}</p>}
      {sched.busy && !sched.data && <p className="muted">Loading…</p>}
      {sched.data &&
        days.map((d) => {
          const list = sched.data!.shifts.filter((s) => dayOf(s.start, org.tz) === d);
          if (!list.length) return null;
          return (
            <section key={d}>
              <h2>{dayName(d)}</h2>
              {list.map((s) => (
                <button key={s.id} className="card link" disabled={!editable(s)} onClick={() => setEdit(s)}>
                  <span className="row-main">
                    <b>
                      {time(s.start, org.tz)}–{time(s.end, org.tz)} · {s.name ?? 'Open'}
                    </b>
                    <span className="muted small block">{s.positionName ?? 'Shift'}</span>
                  </span>
                </button>
              ))}
            </section>
          );
        })}
      {sched.data && !sched.data.shifts.length && <p className="empty">No published shifts this week.</p>}
      <p className="muted small">Building schedules and changing structure are in Kea on the computer.</p>
      {edit && <ShiftSheet org={org} shift={edit} onClose={() => setEdit(null)} onDone={() => (setEdit(null), sched.reload())} />}
    </>
  );
}

const hm = (iso: string, tz: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz });
function ShiftSheet({ org, shift, onClose, onDone }: { org: WorkOrg; shift: TeamShift; onClose(): void; onDone(): void }) {
  const members = useLoad(() => get<{ members: { id: string; name: string; status: string }[] }>(org, path(org, '/members')), [org.id]);
  const [who, setWho] = useState(shift.accountId ?? '');
  const [date, setDate] = useState(shift.date || dayOf(shift.start, org.tz));
  const [st, setSt] = useState(hm(shift.start, org.tz));
  const [en, setEn] = useState(hm(shift.end, org.tz));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ message: string; canForce: boolean } | null>(null);
  const moved = date !== (shift.date || dayOf(shift.start, org.tz)) || st !== hm(shift.start, org.tz) || en !== hm(shift.end, org.tz);
  const save = async (force = false) => {
    setBusy(true);
    setProblem(null);
    try {
      const body: Record<string, unknown> = { accountId: who || null, ...(force ? { force: true } : {}) };
      if (moved) Object.assign(body, { date, start: st, end: en });
      await work.call(org.id, 'POST', path(org, `/shifts/${shift.id}`), body);
      // (A changed published shift waits for publishing again, so people only see what's final.)
      if (shift.scheduleId && can(org, 'schedule.publish')) {
        try {
          await work.call(org.id, 'POST', path(org, `/schedules/${shift.scheduleId}/publish`), {});
          toast('Changed and published.');
        } catch (e: any) {
          if (e?.status === 409 && window.confirm(`${errText(e)}`)) {
            await work.call(org.id, 'POST', path(org, `/schedules/${shift.scheduleId}/publish`), { confirmOverBudget: true });
            toast('Changed and published.');
          } else toast('Changed. Publish the schedule so people see it.');
        }
      } else toast('Changed. It shows once the schedule is published again.');
      onDone();
    } catch (e: any) {
      if (e?.status === 409) setProblem({ message: errText(e), canForce: !!e?.data?.canForce });
      else toast(e?.status === 0 ? `That needs a connection to ${org.name}.` : errText(e));
    } finally {
      setBusy(false);
    }
  };
  const people = (members.data?.members ?? []).filter((m) => m.status === 'active');
  return (
    <Sheet title={shift.positionName ?? 'Shift'} onClose={onClose}>
      <label className="field">
        Who
        <select className="input" value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="">Nobody (open)</option>
          {people.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Day
        <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      <div className="grid2">
        <label className="field">
          Starts
          <input className="input" type="time" value={st} onChange={(e) => setSt(e.target.value)} />
        </label>
        <label className="field">
          Ends
          <input className="input" type="time" value={en} onChange={(e) => setEn(e.target.value)} />
        </label>
      </div>
      {problem && <p className="note warn">{problem.message}</p>}
      <div className="actions">
        {problem?.canForce ? (
          <button className="btn" disabled={busy} onClick={() => save(true)}>
            Change anyway
          </button>
        ) : null}
        <button className="btn primary" disabled={busy || (who === (shift.accountId ?? '') && !moved)} onClick={() => save(false)}>
          Save
        </button>
      </div>
      <p className="muted small">Times are in {org.name}’s time zone ({org.tz}).</p>
    </Sheet>
  );
}

