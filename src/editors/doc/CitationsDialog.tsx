import { useMemo, useState } from 'react';
import { X, Plus, Trash2, Search, Loader2, Quote, BookOpen, Wand2 } from 'lucide-react';
import type { DocMeta, Source } from './docMeta';
import { reference, inText, STYLE_LABEL, Style } from './citations';
import { api } from '../../lib/api';
import { uid } from '../../lib/util';
import { toast } from '../../store';
import { setting } from '../../lib/settings';

const TYPES: { value: Source['type']; label: string }[] = [
  { value: 'book', label: 'Book' },
  { value: 'website', label: 'Web page' },
  { value: 'journal', label: 'Journal article' },
  { value: 'article', label: 'News / magazine article' },
  { value: 'video', label: 'Video' },
  { value: 'chapter', label: 'Chapter in a book' },
  { value: 'report', label: 'Report' },
  { value: 'other', label: 'Other' }
];
const CONTAINER: Record<string, string> = { journal: 'Journal', website: 'Website name', article: 'Newspaper / magazine', video: 'Site (e.g. YouTube)', chapter: 'Book title' };
const today = () => {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
};
const blank = (type: Source['type'] = 'website'): Source => ({ id: uid(), type, authors: [{ first: '', last: '' }], title: '', accessed: type === 'website' || type === 'video' ? today() : '' });

export interface CiteTarget {
  pos: number;
  ids: string[];
  page: string;
}

/** Manage sources, insert or edit citations, and add the bibliography. */
export function CitationsDialog({
  meta,
  target,
  hasBibliography,
  onMeta,
  onCite,
  onRemoveCite,
  onBibliography,
  onClose
}: {
  meta: DocMeta;
  target: CiteTarget | null;
  hasBibliography: boolean;
  onMeta(m: DocMeta): void;
  onCite(ids: string[], page: string): void;
  onRemoveCite(): void;
  onBibliography(): void;
  onClose(): void;
}) {
  const [sources, setSources] = useState<Source[]>(meta.sources);
  const [style, setStyle] = useState<Style>(meta.citationStyle);
  const [sel, setSel] = useState<string[]>(target?.ids || (meta.sources[0] ? [meta.sources[0].id] : []));
  const [editing, setEditing] = useState<Source | null>(meta.sources.length ? null : blank());
  const [page, setPage] = useState(target?.page || '');
  const [q, setQ] = useState('');
  const [lookup, setLookup] = useState('');
  const [busy, setBusy] = useState(false);
  const allowLookup = setting<boolean>('privacy.citeLookup');

  const commit = (list: Source[], st: Style = style) => {
    setSources(list);
    onMeta({ ...meta, sources: list, citationStyle: st });
  };
  const shown = useMemo(() => sources.filter((s) => !q || (s.title + ' ' + s.authors.map((a) => a.last).join(' ') + ' ' + (s.org || '')).toLowerCase().includes(q.toLowerCase())), [sources, q]);
  const selected = sources.filter((s) => sel.includes(s.id));

  const saveSource = () => {
    if (!editing) return;
    const src = { ...editing, authors: editing.authors.filter((a) => a.first.trim() || a.last.trim()) };
    if (!src.title.trim()) return toast('Give the source a title first.', 'error');
    const exists = sources.some((s) => s.id === src.id);
    const list = exists ? sources.map((s) => (s.id === src.id ? src : s)) : [...sources, src];
    commit(list);
    setSel(exists ? sel : [src.id]);
    setEditing(null);
  };

  const doLookup = async () => {
    if (!lookup.trim()) return;
    setBusy(true);
    try {
      const r = await api.citeLookup(lookup.trim());
      const t = (r.type as Source['type']) || 'website';
      setEditing({ ...blank(t), ...r, id: editing?.id || uid(), authors: r.authors?.length ? r.authors : [{ first: '', last: '' }] });
      setLookup('');
    } catch (err: any) {
      toast(String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error');
    } finally {
      setBusy(false);
    }
  };

  const F = (label: string, key: keyof Source, opts: { ph?: string; w?: number } = {}) => (
    <label className="cf">
      <span>{label}</span>
      <input className="input sm" style={opts.w ? { width: opts.w } : undefined} placeholder={opts.ph} value={(editing as any)?.[key] || ''} onChange={(e) => setEditing({ ...editing!, [key]: e.target.value })} />
    </label>
  );

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog cite-dialog">
        <div className="ai-settings-head">
          <h2>{target ? 'Edit citation' : 'Citations'}</h2>
          <select
            className="select"
            value={style}
            onChange={(e) => {
              const st = e.target.value as Style;
              setStyle(st);
              commit(sources, st);
            }}
            title="Citation style"
          >
            {(Object.keys(STYLE_LABEL) as Style[]).map((k) => (
              <option key={k} value={k}>
                {STYLE_LABEL[k]}
              </option>
            ))}
          </select>
          <button className="icon-btn sm" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="cite-body">
          <div className="cite-list">
            <div className="search-box" style={{ width: 'auto', margin: '0 0 8px' }}>
              <Search size={15} />
              <input placeholder="Search sources" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            {shown.map((s) => (
              <div
                key={s.id}
                className={`cite-src ${sel.includes(s.id) ? 'on' : ''}`}
                onClick={(e) => setSel(e.ctrlKey || e.metaKey || e.shiftKey ? (sel.includes(s.id) ? sel.filter((x) => x !== s.id) : [...sel, s.id]) : [s.id])}
                onDoubleClick={() => setEditing(s)}
              >
                <div className="cite-ref" dangerouslySetInnerHTML={{ __html: reference(s, style) }} />
                <div className="cite-src-actions">
                  <button className="link-btn" onClick={(e) => (e.stopPropagation(), setEditing(s))}>
                    Edit
                  </button>
                  <button
                    className="icon-btn sm"
                    title="Delete source"
                    onClick={(e) => {
                      e.stopPropagation();
                      commit(sources.filter((x) => x.id !== s.id));
                      setSel(sel.filter((x) => x !== s.id));
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ))}
            {!sources.length && <div className="muted" style={{ padding: 8, fontSize: 13 }}>No sources yet. Add one on the right.</div>}
            <button className="btn sm" style={{ marginTop: 8 }} onClick={() => setEditing(blank())}>
              <Plus size={14} /> New source
            </button>
          </div>

          <div className="cite-form">
            {editing ? (
              <>
                {allowLookup && (
                  <div className="cite-lookup">
                    <input className="input sm" placeholder="Paste a DOI, ISBN or web address to fill this in" value={lookup} onChange={(e) => setLookup(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && doLookup()} />
                    <button className="btn sm tonal" onClick={doLookup} disabled={busy}>
                      {busy ? <Loader2 size={14} className="spin" /> : <Wand2 size={14} />} Look up
                    </button>
                  </div>
                )}
                <label className="cf">
                  <span>Type</span>
                  <select className="select" value={editing.type} onChange={(e) => setEditing({ ...editing, type: e.target.value as Source['type'] })}>
                    {TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="cf">
                  <span>Authors</span>
                  <div className="cf-authors">
                    {editing.authors.map((a, i) => (
                      <div key={i} className="cf-author">
                        <input className="input sm" placeholder="First name" value={a.first} onChange={(e) => setEditing({ ...editing, authors: editing.authors.map((x, j) => (j === i ? { ...x, first: e.target.value } : x)) })} />
                        <input className="input sm" placeholder="Last name" value={a.last} onChange={(e) => setEditing({ ...editing, authors: editing.authors.map((x, j) => (j === i ? { ...x, last: e.target.value } : x)) })} />
                        <button className="icon-btn sm" title="Remove" onClick={() => setEditing({ ...editing, authors: editing.authors.filter((_, j) => j !== i) })}>
                          <X size={13} />
                        </button>
                      </div>
                    ))}
                    <button className="link-btn" onClick={() => setEditing({ ...editing, authors: [...editing.authors, { first: '', last: '' }] })}>
                      + Add author
                    </button>
                  </div>
                </div>
                {F('Organization', 'org', { ph: 'If there is no person as author' })}
                {F('Title', 'title')}
                {CONTAINER[editing.type] && F(CONTAINER[editing.type], 'container')}
                {F('Publisher', 'publisher')}
                <div className="cf">
                  <span>Published</span>
                  <div className="cf-row">
                    <input className="input sm" style={{ width: 70 }} placeholder="Year" value={editing.year || ''} onChange={(e) => setEditing({ ...editing, year: e.target.value })} />
                    <input className="input sm" style={{ width: 90 }} placeholder="Month" value={editing.month || ''} onChange={(e) => setEditing({ ...editing, month: e.target.value })} />
                    <input className="input sm" style={{ width: 60 }} placeholder="Day" value={editing.day || ''} onChange={(e) => setEditing({ ...editing, day: e.target.value })} />
                  </div>
                </div>
                {(editing.type === 'journal' || editing.type === 'article') && (
                  <div className="cf">
                    <span>Volume / issue</span>
                    <div className="cf-row">
                      <input className="input sm" style={{ width: 80 }} placeholder="Volume" value={editing.volume || ''} onChange={(e) => setEditing({ ...editing, volume: e.target.value })} />
                      <input className="input sm" style={{ width: 80 }} placeholder="Issue" value={editing.issue || ''} onChange={(e) => setEditing({ ...editing, issue: e.target.value })} />
                    </div>
                  </div>
                )}
                {['journal', 'chapter', 'article'].includes(editing.type) && F('Pages', 'pages', { ph: 'e.g. 45–67' })}
                {editing.type === 'book' && F('Edition', 'edition', { ph: 'e.g. 3rd' })}
                {editing.type === 'book' && style === 'chicago' && F('City', 'city')}
                {F('Web address', 'url', { ph: 'https://' })}
                {['journal', 'book', 'chapter', 'report'].includes(editing.type) && F('DOI', 'doi', { ph: '10.xxxx/…' })}
                {['website', 'video', 'article'].includes(editing.type) && (
                  <label className="cf">
                    <span>Accessed</span>
                    <input className="input sm" type="date" value={editing.accessed || ''} onChange={(e) => setEditing({ ...editing, accessed: e.target.value })} />
                  </label>
                )}
                <div className="cite-preview">
                  <div className="muted">Preview</div>
                  <div className="cite-ref" dangerouslySetInnerHTML={{ __html: reference(editing, style) }} />
                  <div className="muted" style={{ marginTop: 4 }}>
                    In the text: {inText([editing], '', style)}
                  </div>
                </div>
                <div className="cf-actions">
                  <button className="btn sm" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                  <button className="btn sm primary" onClick={saveSource}>
                    Save source
                  </button>
                </div>
              </>
            ) : (
              <div className="cite-insert">
                {selected.length ? (
                  <>
                    <div className="muted">Selected {selected.length > 1 ? `${selected.length} sources (Ctrl+click to pick several)` : 'source'}</div>
                    {selected.map((s) => (
                      <div key={s.id} className="cite-ref" dangerouslySetInnerHTML={{ __html: reference(s, style) }} />
                    ))}
                    <label className="cf" style={{ marginTop: 10 }}>
                      <span>Page(s)</span>
                      <input className="input sm" style={{ width: 120 }} placeholder="optional" value={page} onChange={(e) => setPage(e.target.value)} />
                    </label>
                    <div className="cite-preview">
                      <div className="muted">Citation</div>
                      <div>{inText(selected, page, style)}</div>
                    </div>
                  </>
                ) : (
                  <div className="muted">Pick a source on the left, or add a new one.</div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="dialog-actions">
          {!hasBibliography && (
            <button className="btn" onClick={() => (onBibliography(), onClose())}>
              <BookOpen size={14} /> Insert {style === 'mla' ? 'Works Cited' : 'References'}
            </button>
          )}
          {target && (
            <button className="btn danger" onClick={() => (onRemoveCite(), onClose())}>
              Remove citation
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>
            Done
          </button>
          <button className="btn primary" disabled={!selected.length || !!editing} onClick={() => (onCite(sel, page), onClose())}>
            <Quote size={14} /> {target ? 'Update citation' : 'Insert citation'}
          </button>
        </div>
      </div>
    </div>
  );
}
