// Idea threads: the owner's own ideas, kept as a running thread of dated notes. Claude can look into a thread (who
// already does this, how, whether Kea could) and its answer lands in the thread. Ideas found by the audit can be added.
import { useEffect, useMemo, useState } from 'react';
import { Pin, Plus, Sparkles, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { ask, toast } from '../../store';
import type { AuditState, IdeaThread, ThreadStatus } from '../../lib/auditTypes';

const STATUS: { id: ThreadStatus; label: string }[] = [
  { id: 'open', label: 'Open' },
  { id: 'exploring', label: 'Exploring' },
  { id: 'parked', label: 'Parked' },
  { id: 'done', label: 'Done' }
];
const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function Threads({ st, busy, selected, onSelect }: { st: AuditState; busy: boolean; selected: string | null; onSelect: (id: string | null) => void }) {
  const [filter, setFilter] = useState<'active' | ThreadStatus | 'all'>('active');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [err, setErr] = useState('');

  const list = useMemo(
    () =>
      st.threads
        .filter((t) => (filter === 'active' ? t.status === 'open' || t.status === 'exploring' : filter === 'all' || t.status === filter))
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt)),
    [st.threads, filter]
  );
  const current = st.threads.find((t) => t.id === selected) || null;

  const create = async () => {
    const t = title.trim() || text.trim().split('\n')[0].slice(0, 80);
    if (!t) return;
    const id = await api.audit.thread('create', { title: t, text: text.trim() });
    setTitle('');
    setText('');
    onSelect(id);
  };

  if (current) return <Thread t={current} st={st} busy={busy} err={err} setErr={setErr} onBack={() => onSelect(null)} />;

  return (
    <>
      <div className="audit-new">
        <input value={title} placeholder="A new idea, in a few words" onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !text && create()} />
        <textarea rows={3} value={text} placeholder="Anything else: why you want it, what you saw, what it might look like… (optional)" onChange={(e) => setText(e.target.value)} />
        <div className="audit-row">
          <button className="btn primary sm" disabled={!title.trim() && !text.trim()} onClick={create}>
            <Plus size={14} /> Start a thread
          </button>
        </div>
      </div>
      <div className="audit-filters">
        <select value={filter} onChange={(e) => setFilter(e.target.value as any)} aria-label="Show">
          <option value="active">Open and exploring</option>
          <option value="all">All threads</option>
          {STATUS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      {!list.length && <p className="audit-muted">{st.threads.length ? 'No threads match.' : 'No threads yet. Put your first idea above; you can keep adding to it whenever you think of more.'}</p>}
      {list.map((t) => (
        <button key={t.id} className="audit-card audit-thread-row" onClick={() => onSelect(t.id)}>
          {t.pinned && <Pin size={13} />}
          <span className="audit-card-title">
            <b>{t.title}</b>
            <em> · {t.entries.length} {t.entries.length === 1 ? 'note' : 'notes'} · {when(t.updatedAt)}</em>
          </span>
          <span className="audit-tag">{STATUS.find((s) => s.id === t.status)?.label}</span>
        </button>
      ))}
    </>
  );
}

function Thread({ t, st, busy, err, setErr, onBack }: { t: IdeaThread; st: AuditState; busy: boolean; err: string; setErr: (s: string) => void; onBack: () => void }) {
  const [add, setAdd] = useState('');
  const [name, setName] = useState(t.title);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [linking, setLinking] = useState('');
  useEffect(() => setName(t.title), [t.title]);
  const asking = st.runs.some((r) => r.status === 'running' && r.kind === 'thread' && r.label === `Thread: ${t.title}`);

  const post = async () => {
    if (!add.trim()) return;
    await api.audit.thread('add', { id: t.id, text: add });
    setAdd('');
  };
  const remove = async () => {
    if ((await ask(`Delete “${t.title}”?`, 'The whole thread and its notes are removed. This can’t be undone.', [{ id: 'no', label: 'Cancel' }, { id: 'yes', label: 'Delete', danger: true, primary: true }])) !== 'yes') return;
    await api.audit.thread('delete', { id: t.id });
    onBack();
  };
  const askClaude = async () => {
    setErr('');
    const r = await api.audit.threadAsk(t.id);
    if (!r.ok) setErr(r.error || 'Claude couldn’t look into that.');
  };
  const linkable = st.findings.filter((f) => !t.entries.some((e) => e.finding === f.id));

  return (
    <div className="audit-thread">
      <div className="audit-row">
        <button className="btn link sm" onClick={onBack}>
          ← All threads
        </button>
      </div>
      <div className="audit-row">
        <input className="audit-thread-title" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== t.title && api.audit.thread('update', { id: t.id, title: name })} aria-label="Title" />
        <select value={t.status} aria-label="Status" onChange={(e) => api.audit.thread('update', { id: t.id, status: e.target.value as ThreadStatus })}>
          {STATUS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <button className={`btn sm ${t.pinned ? 'primary' : ''}`} title="Keep at the top" onClick={() => api.audit.thread('update', { id: t.id, pinned: !t.pinned })}>
          <Pin size={14} />
        </button>
        <button className="btn sm" title="Delete thread" aria-label="Delete thread" onClick={remove}>
          <Trash2 size={14} />
        </button>
      </div>
      {err && <div className="audit-problem">{err}</div>}

      {!t.entries.length && <p className="audit-muted">Nothing in this thread yet. Write the first note below.</p>}
      {t.entries.map((e) => (
        <div key={e.id} className={`audit-entry ${e.by}`}>
          <div className="audit-entry-head">
            <b>{e.by === 'claude' ? 'Claude’s research' : e.by === 'finding' ? 'From the audit' : 'You'}</b>
            <span className="audit-muted">
              {when(e.at)}
              {e.editedAt ? ' · edited' : ''}
            </span>
            <span className="audit-spacer" />
            {e.by === 'owner' && editing?.id !== e.id && (
              <button className="btn link sm" onClick={() => setEditing({ id: e.id, text: e.text })}>
                Edit
              </button>
            )}
            <button
              className="btn link sm"
              onClick={async () => {
                if ((await ask('Delete this note?', 'It’s removed from the thread.', [{ id: 'no', label: 'Cancel' }, { id: 'yes', label: 'Delete', danger: true, primary: true }])) === 'yes') api.audit.thread('deleteEntry', { id: t.id, entry: e.id });
              }}
            >
              Delete
            </button>
          </div>
          {editing?.id === e.id ? (
            <>
              <textarea className="audit-note" rows={4} value={editing.text} onChange={(ev) => setEditing({ id: e.id, text: ev.target.value })} />
              <div className="audit-row">
                <button
                  className="btn primary sm"
                  onClick={async () => {
                    await api.audit.thread('editEntry', { id: t.id, entry: e.id, text: editing.text });
                    setEditing(null);
                  }}
                >
                  Save
                </button>
                <button className="btn sm" onClick={() => setEditing(null)}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <div className="audit-entry-text">{e.text}</div>
          )}
        </div>
      ))}

      <div className="audit-new">
        <textarea rows={3} value={add} placeholder="Add a note to this thread…" onChange={(e) => setAdd(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && post()} />
        <div className="audit-row">
          <button className="btn primary sm" disabled={!add.trim()} onClick={post}>
            Add note
          </button>
          <button className="btn sm" disabled={busy || asking} title="Searches the web for who already does this and whether Kea could" onClick={askClaude}>
            <Sparkles size={14} /> {asking ? 'Looking into it…' : 'Ask Claude to look into this'}
          </button>
          {!!linkable.length && (
            <select
              value={linking}
              aria-label="Add an audit idea"
              onChange={async (e) => {
                setLinking('');
                if (e.target.value && (await api.audit.thread('link', { id: t.id, finding: e.target.value }))) toast('Added to the thread.');
              }}
            >
              <option value="">Add an idea from the audit…</option>
              {linkable.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.feature} ({f.app})
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
    </div>
  );
}
