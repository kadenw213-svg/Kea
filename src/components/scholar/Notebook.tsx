// The notebook beside a quiz: plain Markdown files the student names and picks, saved about a second after typing
// stops and when the panel closes. The files are in the Notebooks folder of the study folder (notebooks.cjs), so they
// open in Kea's Markdown editor too. Which notebook was last used is remembered per class.
//
// They sync to the other computers and the phone (notebookSync.cjs). A change that arrives while one is open shows
// here when nothing typed is waiting to be saved; a save never writes over a change that came in meanwhile (that text
// is kept as "<name> (changed elsewhere)"). On the phone the same panel only shows them (`readOnly`).
import { useEffect, useRef, useState } from 'react';
import { Check, ExternalLink, NotebookPen, Pencil, Plus, X } from 'lucide-react';
import { api } from '../../lib/api';
import { useSettings } from '../../lib/settings';
import { openPaths } from '../../lib/open';
import { toast } from '../../store';

type Entry = { name: string; file: string; modified: string };

const LAST_KEY = 'study.notebook.last';
const lastFor = (course: string): string => (useSettings.getState().values[LAST_KEY] || {})[course || 'all'] || '';
const rememberLast = (course: string, name: string) => useSettings.getState().set({ [LAST_KEY]: { ...(useSettings.getState().values[LAST_KEY] || {}), [course || 'all']: name } });
const errText = (e: any) => String(e?.message || e || 'It didn’t work.').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** The Notebook button for the player's header. */
export function NotebookButton({ open, onClick }: { open: boolean; onClick(): void }) {
  return (
    <button className={`btn sm st-nb-btn ${open ? 'on' : ''}`} onClick={onClick} title={open ? 'Close the notebook' : 'Take notes beside the questions'} aria-pressed={open}>
      <NotebookPen size={13} /> Notebook
    </button>
  );
}

export function NotebookPane({ courseId, side, onClose }: { courseId: string; side: 'left' | 'right'; onClose(): void }) {
  const [list, setList] = useState<Entry[] | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [status, setStatus] = useState<'saved' | 'saving' | 'unsaved' | 'error'>('saved');
  // Naming a new notebook, or renaming this one (null: neither).
  const [naming, setNaming] = useState<{ mode: 'new' | 'rename'; value: string; error: string } | null>(null);
  // What's typed and not saved yet, so a switch or close saves it first.
  const pending = useRef<{ name: string; text: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textRef = useRef(text);
  textRef.current = text;
  const nameRef = useRef(name);
  nameRef.current = name;
  // The notebook's text as last read or saved here, so a save can tell when the file changed meanwhile.
  const baseRef = useRef<{ name: string; text: string } | null>(null);

  const flush = async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    setStatus('saving');
    try {
      const base = baseRef.current?.name === p.name ? baseRef.current.text : undefined;
      const r = await api.scholar.notebookWrite(p.name, p.text, base);
      baseRef.current = { name: p.name, text: p.text };
      if (!pending.current) setStatus('saved');
      if (r?.kept) {
        toast(`“${p.name}” changed on another device or in another program while you were writing. That version is kept as “${r.kept}”.`, 'info');
        refresh(nameRef.current);
      }
    } catch (e) {
      // (Kept to try again with the next change.)
      if (!pending.current) pending.current = p;
      setStatus('error');
      toast(`Couldn’t save the notebook: ${errText(e)}`, 'error');
    }
  };

  const load = async (n: string) => {
    await flush();
    setName(n);
    setText('');
    baseRef.current = null;
    setStatus('saved');
    if (!n) return;
    rememberLast(courseId, n);
    try {
      const t = await api.scholar.notebookRead(n);
      baseRef.current = { name: n, text: t };
      setText(t);
    } catch (e) {
      toast(`Couldn’t open the notebook: ${errText(e)}`, 'error');
    }
  };

  const refresh = async (pick?: string) => {
    const r = await Promise.resolve()
      .then(() => api.scholar.notebookList())
      .catch(() => ({ list: [] as Entry[], readOnly: false }));
    setList(r.list);
    setReadOnly(!!r.readOnly);
    return pick !== undefined ? pick : r.list.find((x) => x.name === lastFor(courseId))?.name || r.list[0]?.name || '';
  };

  // The class's last notebook (or the newest) when the panel opens or the class changes.
  useEffect(() => {
    refresh().then(load);
  }, [courseId]);
  // Notebooks synced in from another device: the list, and this one's text when nothing typed is waiting to be saved.
  useEffect(
    () =>
      api.scholar.onChanged(() => {
        refresh(nameRef.current).then(() => reread());
      }),
    []
  );
  // Saved when the panel closes (or the player does).
  useEffect(
    () => () => {
      flush();
    },
    []
  );

  const type = (v: string) => {
    setText(v);
    if (!name) return;
    pending.current = { name, text: v };
    setStatus('unsaved');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 1000);
  };

  // Back from the editor (or another program): the file as it is now, when nothing here is waiting to be saved.
  const reread = async () => {
    const n = nameRef.current;
    if (!n || pending.current) return;
    const before = textRef.current;
    const now = await Promise.resolve()
      .then(() => api.scholar.notebookRead(n))
      .catch(() => null);
    if (now == null || nameRef.current !== n || textRef.current !== before || pending.current) return;
    baseRef.current = { name: n, text: now };
    if (now !== before) setText(now);
  };

  const submitName = async () => {
    if (!naming) return;
    const value = naming.value.trim();
    try {
      if (naming.mode === 'new') {
        const made = await api.scholar.notebookCreate(value);
        setNaming(null);
        await refresh(made.name);
        await load(made.name);
      } else {
        await flush();
        const done = await api.scholar.notebookRename(name, value);
        setNaming(null);
        setName(done.name);
        rememberLast(courseId, done.name);
        await refresh(done.name);
      }
    } catch (e) {
      setNaming({ ...naming, error: errText(e) });
    }
  };

  const openInEditor = async () => {
    await flush();
    const f = list?.find((x) => x.name === name)?.file;
    if (f) openPaths([f]);
  };

  const nameKeys = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') submitName();
    if (e.key === 'Escape') {
      // (Esc here only stops naming: it doesn't close the quiz.)
      e.stopPropagation();
      setNaming(null);
    }
  };

  return (
    <aside className={`st-notebook ${side}`} aria-label="Notebook">
      <div className="st-nb-head">
        {naming ? (
          <>
            <input
              className="input sm st-nb-name"
              autoFocus
              maxLength={80}
              value={naming.value}
              placeholder={naming.mode === 'new' ? 'Name the new notebook' : 'New name'}
              onChange={(e) => setNaming({ ...naming, value: e.target.value, error: '' })}
              onKeyDown={nameKeys}
            />
            <button className="icon-btn sm" onClick={submitName} title={naming.mode === 'new' ? 'Make it' : 'Rename'}>
              <Check size={14} />
            </button>
            <button className="icon-btn sm" onClick={() => setNaming(null)} title="Cancel">
              <X size={14} />
            </button>
          </>
        ) : (
          <>
            <select className="input sm st-nb-pick" value={name} onChange={(e) => load(e.target.value)} disabled={!list?.length} aria-label="Notebook">
              {!list?.length && <option value="">No notebooks yet</option>}
              {list?.map((x) => (
                <option key={x.name} value={x.name}>
                  {x.name}
                </option>
              ))}
            </select>
            {!readOnly && (
              <button className="icon-btn sm" onClick={() => setNaming({ mode: 'new', value: '', error: '' })} title="New notebook">
                <Plus size={14} />
              </button>
            )}
            {name && !readOnly && (
              <button className="icon-btn sm" onClick={() => setNaming({ mode: 'rename', value: name, error: '' })} title="Rename this notebook">
                <Pencil size={13} />
              </button>
            )}
            <button className="icon-btn sm" onClick={onClose} title="Close the notebook">
              <X size={14} />
            </button>
          </>
        )}
      </div>
      {naming?.error && <div className="st-nb-error">{naming.error}</div>}
      {naming && !naming.error && <div className="st-nb-hint">Letters, numbers, spaces and - _ . ( ) only.</div>}
      {name && readOnly ? (
        <textarea className="st-nb-text" value={text} readOnly placeholder="This notebook is empty." />
      ) : readOnly ? (
        list && (
          <div className="st-nb-empty">
            <p>Notebooks you write while studying in Kea on your PC show here. On the phone you can read them.</p>
          </div>
        )
      ) : name ? (
        <textarea className="st-nb-text" value={text} onChange={(e) => type(e.target.value)} onBlur={flush}
          onFocus={reread}
          // (Esc while writing leaves the notebook instead of closing the quiz.)
          onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), e.currentTarget.blur())}
          placeholder="Notes and questions for later…" spellCheck />
      ) : (
        list && (
          <div className="st-nb-empty">
            <p>Write notes and questions here while you study. Each notebook is a .md file you name.</p>
            <button className="btn sm" onClick={() => setNaming({ mode: 'new', value: '', error: '' })}>
              <Plus size={13} /> New notebook
            </button>
          </div>
        )
      )}
      {name && readOnly && (
        <div className="st-nb-foot">
          <span className="st-nb-status">Read only on the phone. Edit it in Kea on your PC.</span>
        </div>
      )}
      {name && !readOnly && (
        <div className="st-nb-foot">
          <span className={`st-nb-status ${status}`}>{status === 'saving' ? 'Saving…' : status === 'unsaved' ? 'Not saved yet' : status === 'error' ? 'Not saved' : 'Saved'}</span>
          <button className="link-btn" onClick={openInEditor}>
            <ExternalLink size={12} /> Open in editor
          </button>
        </div>
      )}
    </aside>
  );
}
