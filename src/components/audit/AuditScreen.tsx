// The product audit tab (owner tool). A specs list of Kea, research runs that find what other apps do, and a plan
// for each idea worth copying. The work happens in electron/audit.cjs through the owner's own Claude Code.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ExternalLink, FolderOpen, Play, RefreshCw, Square } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../store';
import type { AuditConfig, AuditRun, AuditState, Finding, FindingStatus } from '../../lib/auditTypes';
import { Threads } from './Threads';
import './audit.css';

type Tab = 'threads' | 'findings' | 'spec' | 'runs' | 'advanced';

const STATUS: { id: FindingStatus; label: string }[] = [
  { id: 'new', label: 'New' },
  { id: 'planned', label: 'Planned' },
  { id: 'accepted', label: 'Accepted' },
  { id: 'building', label: 'Building' },
  { id: 'done', label: 'Done' },
  { id: 'dismissed', label: 'Dismissed' }
];
const FEAS: Record<Finding['feasibility'], string> = { easy: 'Easy', moderate: 'Moderate', hard: 'Hard', 'not-feasible': 'Not feasible' };

const ago = (iso: string | null) => {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} days ago`;
};

export function AuditScreen() {
  const [st, setSt] = useState<AuditState | null>(null);
  const [tab, setTab] = useState<Tab>('threads');
  const [thread, setThread] = useState<string | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    api.audit.state().then(setSt, (e) => setErr(String(e?.message || e)));
  }, []);
  useEffect(() => {
    load();
    return api.audit.onChanged(load);
  }, [load]);

  const running = useMemo(() => (st?.runs || []).filter((r) => r.status === 'running'), [st]);
  const busy = running.length > 0 || !!st?.busy;

  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>, okMsg?: string) => {
    setErr('');
    const r = await fn().catch((e) => ({ ok: false, error: String(e?.message || e) }));
    if (!r.ok) setErr(r.error || 'That didn’t work.');
    else if (okMsg) toast(okMsg);
    load();
  };

  if (!st) {
    return (
      <div className="audit">
        <div className="audit-inner">{err ? <div className="audit-problem">{err}</div> : <div className="spinner" />}</div>
      </div>
    );
  }

  const fresh = st.findings.filter((f) => f.status === 'new').length;
  const runAudit = async () => {
    setErr('');
    // The specs list first (research is told what Kea already has), then every topic that is on.
    if (!st.spec || !st.specAt || Date.now() - new Date(st.specAt).getTime() > 7 * 86400000) {
      const r = await api.audit.buildSpec();
      if (!r.ok) return setErr(r.error || 'The specs list didn’t build.');
    }
    const r = await api.audit.research();
    if (!r.ok) setErr(r.error || 'Research didn’t start.');
    setTab('runs');
    load();
  };

  return (
    <div className="audit">
      <div className="audit-inner">
        <header className="audit-head">
          <div>
            <h2 className="audit-title">Product audit</h2>
            <p className="audit-sub">
              Specs list updated {ago(st.specAt)} · last research {ago(st.lastResearch)} · {fresh} new {fresh === 1 ? 'idea' : 'ideas'}
            </p>
          </div>
          <div className="audit-actions">
            {busy ? (
              <button className="btn" onClick={() => api.audit.stop()}>
                <Square size={14} /> Stop
              </button>
            ) : (
              <button className="btn primary" onClick={runAudit}>
                <Play size={14} /> Run audit
              </button>
            )}
          </div>
        </header>

        {err && <div className="audit-problem">{err}</div>}
        {!st.repo && (
          <div className="audit-problem">
            Kea’s source folder wasn’t found, so the specs list and plans can’t read the code. Set it under Advanced.
          </div>
        )}
        {running.map((r) => (
          <div key={r.id} className="audit-running">
            <div className="spinner sm" />
            <b>{r.label}</b>
            <span>{r.step}</span>
          </div>
        ))}

        <nav className="audit-tabs">
          {([['threads', `My ideas (${st.threads.filter((t) => t.status !== 'done' && t.status !== 'parked').length})`], ['findings', `Found by audit (${st.findings.filter((f) => f.status !== 'dismissed').length})`], ['spec', 'Specs list'], ['runs', 'Runs'], ['advanced', 'Advanced']] as [Tab, string][]).map(([id, label]) => (
            <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </nav>

        {tab === 'threads' && <Threads st={st} busy={busy} selected={thread} onSelect={setThread} />}
        {tab === 'findings' && <Findings st={st} onPlan={(id) => act(() => api.audit.plan(id))} reload={load} onThread={(id) => { setThread(id); setTab('threads'); }} />}
        {tab === 'spec' && <Spec st={st} busy={busy} onBuild={() => act(() => api.audit.buildSpec(), 'Specs list updated.')} />}
        {tab === 'runs' && <Runs runs={st.runs} />}
        {tab === 'advanced' && <Advanced st={st} reload={load} onResearch={(ids) => act(() => api.audit.research(ids))} busy={busy} />}
      </div>
    </div>
  );
}

// ---------- Ideas ----------
function Findings({ st, onPlan, reload, onThread }: { st: AuditState; onPlan: (id: string) => void; reload: () => void; onThread: (id: string) => void }) {
  const [status, setStatus] = useState<'open' | FindingStatus | 'all'>('open');
  const [cat, setCat] = useState('all');
  const [sort, setSort] = useState<'value' | 'newest' | 'easy'>('value');
  const [openId, setOpenId] = useState<string | null>(null);
  const catLabel = (id: string) => st.categories.find((c) => c.id === id)?.label || id;

  const list = st.findings
    .filter((f) => (status === 'open' ? f.status !== 'dismissed' && f.status !== 'done' : status === 'all' ? true : f.status === status))
    .filter((f) => cat === 'all' || f.category === cat)
    .sort((a, b) => {
      if (sort === 'newest') return b.foundAt.localeCompare(a.foundAt);
      if (sort === 'easy') return ['easy', 'moderate', 'hard', 'not-feasible'].indexOf(a.feasibility) - ['easy', 'moderate', 'hard', 'not-feasible'].indexOf(b.feasibility) || b.value - a.value;
      return b.value - a.value || b.foundAt.localeCompare(a.foundAt);
    });

  if (!st.findings.length) {
    return (
      <div className="audit-empty">
        <h3>No ideas yet</h3>
        <p>Run the audit. Kea builds its specs list, then your Claude Code researches each topic on the web and reports back what other apps do that Kea doesn’t.</p>
      </div>
    );
  }
  return (
    <>
      <div className="audit-filters">
        <select value={status} onChange={(e) => setStatus(e.target.value as any)} aria-label="Show">
          <option value="open">Open ideas</option>
          <option value="all">Everything</option>
          {STATUS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <select value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Topic">
          <option value="all">All topics</option>
          {st.categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as any)} aria-label="Sort">
          <option value="value">Most wanted first</option>
          <option value="easy">Easiest first</option>
          <option value="newest">Newest first</option>
        </select>
      </div>
      {!list.length && <p className="audit-muted">Nothing matches.</p>}
      {list.map((f) => {
        const open = openId === f.id;
        return (
          <article key={f.id} className={`audit-card ${f.status}`}>
            <button className="audit-card-head" aria-expanded={open} onClick={() => setOpenId(open ? null : f.id)}>
              <span className="audit-stars" title={`Value ${f.value} of 5`}>
                {'★'.repeat(f.value)}
                <i>{'★'.repeat(5 - f.value)}</i>
              </span>
              <span className="audit-card-title">
                <b>{f.feature}</b> <em>in {f.app}</em>
              </span>
              <span className={`audit-tag feas-${f.feasibility}`}>{FEAS[f.feasibility]}</span>
              <span className="audit-tag">{f.keaHas === 'none' ? 'Kea: missing' : f.keaHas === 'partial' ? 'Kea: partly' : 'Kea has it'}</span>
              <span className="audit-tag">{f.age === 'newer' ? 'Newer app' : 'Established'}</span>
            </button>
            {open && (
              <div className="audit-card-body">
                <p>{f.what}</p>
                <dl>
                  <dt>How it likely works</dt>
                  <dd>{f.howItWorks}</dd>
                  <dt>How Kea could build it</dt>
                  <dd>
                    {f.approach} {f.effort && <em>({f.effort})</em>}
                  </dd>
                  <dt>What can be learned from outside</dt>
                  <dd>{f.observable}</dd>
                  <dt>Terms, patent and licence risk</dt>
                  <dd>{f.risk || 'None found.'}</dd>
                  <dt>Topic</dt>
                  <dd>{catLabel(f.category)}</dd>
                </dl>
                {!!f.sources.length && (
                  <p className="audit-links">
                    {[f.url, ...f.sources].filter((u, i, a) => u && a.indexOf(u) === i).slice(0, 6).map((u) => (
                      <button key={u} className="btn link sm" onClick={() => api.audit.openUrl(u)} title={u}>
                        <ExternalLink size={12} /> {u.replace(/^https?:\/\/(www\.)?/, '').slice(0, 44)}
                      </button>
                    ))}
                  </p>
                )}
                {f.plan && (
                  <details className="audit-plan" open>
                    <summary>
                      Plan{f.plan.verdict ? `: ${f.plan.verdict}` : ''} <span className="audit-muted">({ago(f.plan.at)})</span>
                    </summary>
                    <pre>{f.plan.text}</pre>
                  </details>
                )}
                <Note f={f} />
                <div className="audit-row">
                  <button className="btn primary sm" disabled={st.busy} onClick={() => onPlan(f.id)}>
                    {f.plan ? 'Plan again' : 'Make a plan'}
                  </button>
                  <select
                    value={f.status}
                    aria-label="Status"
                    onChange={async (e) => {
                      await api.audit.setStatus(f.id, e.target.value as FindingStatus);
                      reload();
                    }}
                  >
                    {STATUS.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                  <select
                    value=""
                    aria-label="Add to a thread"
                    onChange={async (e) => {
                      const v = e.target.value;
                      if (!v) return;
                      const id = v === 'new' ? await api.audit.thread('create', { title: `${f.feature} (${f.app})` }) : v;
                      await api.audit.thread('link', { id, finding: f.id });
                      onThread(id);
                    }}
                  >
                    <option value="">Add to a thread…</option>
                    <option value="new">A new thread</option>
                    {st.threads.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.title}
                      </option>
                    ))}
                  </select>
                  {f.plan && (
                    <button className="btn sm" onClick={() => navigator.clipboard.writeText(`Feature to build in Kea: ${f.feature} (seen in ${f.app})\n\n${f.plan!.text}`).then(() => toast('Plan copied. Paste it into a Claude chat to start building.'))}>
                      Copy plan
                    </button>
                  )}
                </div>
              </div>
            )}
          </article>
        );
      })}
    </>
  );
}

function Note({ f }: { f: Finding }) {
  const [v, setV] = useState(f.note || '');
  return (
    <textarea
      className="audit-note"
      placeholder="Your note on this idea…"
      value={v}
      rows={2}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== (f.note || '') && api.audit.setNote(f.id, v)}
    />
  );
}

// ---------- Specs list ----------
function Spec({ st, busy, onBuild }: { st: AuditState; busy: boolean; onBuild: () => void }) {
  return (
    <>
      <div className="audit-row">
        <button className="btn primary sm" disabled={busy || !st.repo} onClick={onBuild}>
          <RefreshCw size={14} /> {st.spec ? 'Update from the code' : 'Build the specs list'}
        </button>
        <span className="audit-muted">{st.specAt ? `Updated ${ago(st.specAt)}. Older copies are kept (last 20).` : 'Claude reads the Kea source and writes what Kea can do, what it uses underneath, and where it’s thin.'}</span>
      </div>
      {st.spec ? <pre className="audit-spec">{st.spec}</pre> : <div className="audit-empty"><h3>No specs list yet</h3></div>}
    </>
  );
}

// ---------- Runs ----------
function Runs({ runs }: { runs: AuditRun[] }) {
  if (!runs.length) return <p className="audit-muted">Nothing has run yet.</p>;
  return (
    <ul className="audit-runs">
      {runs.map((r) => (
        <li key={r.id} className={r.status}>
          <b>{r.label}</b>
          <span className="audit-tag">{{ running: 'Running', done: 'Done', failed: 'Failed', stopped: 'Stopped' }[r.status]}</span>
          <span className="audit-muted">
            {ago(r.start)}
            {r.note ? ` · ${r.note}` : ''}
          </span>
        </li>
      ))}
    </ul>
  );
}

// ---------- Advanced ----------
function Advanced({ st, reload, onResearch, busy }: { st: AuditState; reload: () => void; onResearch: (ids: string[]) => void; busy: boolean }) {
  const c = st.config;
  const set = async (p: Partial<AuditConfig>) => {
    await api.audit.setConfig(p);
    reload();
  };
  const [extra, setExtra] = useState(c.extraTopics);
  const [repo, setRepo] = useState(c.repoPath);
  const models = ['haiku', 'sonnet', 'opus'];
  return (
    <div className="audit-adv">
      <section>
        <h3>Topics to research</h3>
        <p className="audit-muted">Each topic is one research run on your Claude Code. “Run audit” does every topic that’s ticked; the button beside a topic does just that one.</p>
        {st.categories.map((cat) => (
          <div key={cat.id} className="audit-topic">
            <label>
              <input type="checkbox" checked={c.categories[cat.id] !== false && !!c.categories[cat.id]} onChange={(e) => set({ categories: { [cat.id]: e.target.checked } as any })} /> {cat.label}
            </label>
            <button className="btn link sm" disabled={busy} onClick={() => onResearch([cat.id])}>
              Research this now
            </button>
          </div>
        ))}
        <label className="audit-field">
          Also watch for (optional)
          <textarea rows={2} value={extra} onChange={(e) => setExtra(e.target.value)} onBlur={() => extra !== c.extraTopics && set({ extraTopics: extra })} placeholder="For example: on-device models, anything for students, voice control" />
        </label>
      </section>
      <section>
        <h3>How it runs</h3>
        <label className="audit-field">
          Kea’s source folder
          <input value={repo} placeholder={st.repo || 'C:\\Users\\you\\Projects\\Kea'} onChange={(e) => setRepo(e.target.value)} onBlur={() => repo !== c.repoPath && set({ repoPath: repo })} />
          <small>{st.repo ? `Using ${st.repo}` : 'Not found yet.'}</small>
        </label>
        {(
          [
            ['researchModel', 'Model for research'],
            ['specModel', 'Model for the specs list'],
            ['planModel', 'Model for plans']
          ] as const
        ).map(([k, label]) => (
          <label key={k} className="audit-field inline">
            {label}
            <select value={c[k]} onChange={(e) => set({ [k]: e.target.value } as any)}>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m[0].toUpperCase() + m.slice(1)}
                </option>
              ))}
            </select>
          </label>
        ))}
        <label className="audit-field inline">
          Research runs at once
          <input type="number" min={1} max={4} value={c.concurrency} onChange={(e) => set({ concurrency: Number(e.target.value) })} />
        </label>
        <label className="audit-field inline">
          Ideas asked for per topic
          <input type="number" min={3} max={15} value={c.perRun} onChange={(e) => set({ perRun: Number(e.target.value) })} />
        </label>
        <label className="audit-field inline">
          Most steps one run may take
          <input type="number" min={20} max={200} value={c.maxTurns} onChange={(e) => set({ maxTurns: Number(e.target.value) })} />
        </label>
        <p className="audit-muted">Runs only read: research can search and read web pages, the specs list and plans can also read Kea’s code. Nothing can write files, run programs or change Kea. Everything uses your own Claude plan.</p>
        <button className="btn sm" onClick={() => api.audit.openFolder()}>
          <FolderOpen size={14} /> Open the audit folder
        </button>
      </section>
    </div>
  );
}
