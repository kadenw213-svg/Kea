import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { Check, X, MoreVertical, CheckCheck, Undo2 } from 'lucide-react';
import type { CommentThread, DocMeta } from './docMeta';
import { commentAnchors, listChanges, resolveChanges, Change } from './review';
import { MenuButton } from '../../components/Popover';
import { uid, timeAgo } from '../../lib/util';
import { Logo } from '../../components/Logo';
import { LEGACY } from '../../lib/legacy';

/** Comments and suggestions made by Kea's AI get the app's logo and a quiet grey look. */
export const AI_AUTHOR = 'Kea AI';
/** Also the name used before the app was renamed, so older documents keep their look. */
export const isAiAuthor = (a?: string) => a === AI_AUTHOR || a === LEGACY.aiAuthor;
const initial = (name: string) => (name.trim()[0] || '?').toUpperCase();
const hue = (name: string) => [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
function Avatar({ name }: { name: string }) {
  if (isAiAuthor(name)) return <Logo size={26} className="rv-avatar ai" />;
  return (
    <span className="rv-avatar" style={{ background: `hsl(${hue(name)} 45% 42%)` }}>
      {initial(name)}
    </span>
  );
}

type Item = { kind: 'comment'; id: string; from: number; thread: CommentThread; quote: string } | { kind: 'change'; id: string; from: number; change: Change; pair?: Change };

/**
 * Comment and suggestion cards beside the page, each lined up with the text it belongs to.
 */
export function ReviewRail({
  editor,
  meta,
  me,
  version,
  active,
  setActive,
  draftId,
  onDraftDone,
  onMeta,
  showResolved,
  setShowResolved,
  stage
}: {
  editor: Editor;
  meta: DocMeta;
  me: string;
  version: number;
  active: string | null;
  setActive(id: string | null): void;
  draftId: string | null;
  onDraftDone(): void;
  onMeta(m: DocMeta): void;
  showResolved: boolean;
  setShowResolved(v: boolean): void;
  stage: HTMLElement | null;
}) {
  const [tops, setTops] = useState<Record<string, number>>({});
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const cardsRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState('');
  const [reply, setReply] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);

  const items = useMemo<Item[]>(() => {
    const anchors = commentAnchors(editor.state);
    const out: Item[] = [];
    for (const t of meta.comments) {
      const a = anchors.get(t.id);
      if (!a) continue;
      if (t.resolved && !showResolved) continue;
      out.push({ kind: 'comment', id: t.id, from: a.from, thread: t, quote: a.text });
    }
    if (draftId && !meta.comments.some((t) => t.id === draftId)) {
      const a = anchors.get(draftId);
      if (a) out.push({ kind: 'comment', id: draftId, from: a.from, thread: { id: draftId, author: me, text: '', at: Date.now(), replies: [] }, quote: a.text });
    }
    // Pair a deletion with the insertion right after it as one "replace" card.
    const changes = listChanges(editor.state);
    const seen = new Set<string>();
    for (const c of changes) {
      if (seen.has(c.id + c.kind)) continue;
      seen.add(c.id + c.kind);
      const pair = changes.find((x) => x.id === c.id && x.kind !== c.kind);
      if (pair && c.kind === 'insertion' && changes.some((x) => x === pair && x.from < c.from)) continue;
      if (pair) seen.add(pair.id + pair.kind);
      out.push({ kind: 'change', id: c.id, from: c.from, change: c, pair });
    }
    return out.sort((a, b) => a.from - b.from);
  }, [editor, meta.comments, version, draftId, showResolved, me]);

  // Line cards up with their text, pushing later cards down so they never overlap.
  useLayoutEffect(() => {
    if (!stage || !cardsRef.current) return;
    // Positions are relative to the card column, so cards line up with their text.
    const st = cardsRef.current.getBoundingClientRect();
    const next: Record<string, number> = {};
    let bottom = 0;
    const order = [...items];
    // Cards stack downwards in document order, each as close to its text as possible.
    for (const it of order) {
      let want = 0;
      try {
        want = editor.view.coordsAtPos(Math.min(it.from + 1, editor.state.doc.content.size)).top - st.top - 4;
      } catch {}
      const top = Math.max(want, bottom);
      next[it.kind + it.id] = top;
      bottom = top + (cardRefs.current.get(it.kind + it.id)?.offsetHeight || 80) + 8;
    }
    if (JSON.stringify(next) !== JSON.stringify(tops)) setTops(next);
  });

  useEffect(() => {
    setDraft('');
    setReply('');
  }, [draftId, active]);

  const setThreads = (fn: (list: CommentThread[]) => CommentThread[]) => onMeta({ ...meta, comments: fn(meta.comments) });
  const removeThread = (id: string) => {
    editor.commands.removeComment(id);
    setThreads((l) => l.filter((t) => t.id !== id));
    setActive(null);
  };

  const changeCount = items.filter((i) => i.kind === 'change').length;
  const resolvedCount = meta.comments.filter((t) => t.resolved).length;

  return (
    <div className="rv-rail">
      {(changeCount > 0 || resolvedCount > 0) && (
        <div className="rv-head">
          {changeCount > 0 && (
            <>
              <button className="btn sm tonal" title="Accept all suggestions" onClick={() => resolveChanges(editor, true)}>
                <CheckCheck size={14} /> Accept all
              </button>
              <button className="btn sm" title="Reject all suggestions" onClick={() => resolveChanges(editor, false)}>
                <Undo2 size={14} /> Reject all
              </button>
            </>
          )}
          {resolvedCount > 0 && (
            <label className="rv-resolved">
              <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> Resolved ({resolvedCount})
            </label>
          )}
        </div>
      )}
      <div className="rv-cards" ref={cardsRef}>
        {items.map((it) => {
          const key = it.kind + it.id;
          const isActive = active === it.id;
          if (it.kind === 'change') {
            const c = it.change;
            const del = c.kind === 'deletion' ? c : it.pair?.kind === 'deletion' ? it.pair : null;
            const ins = c.kind === 'insertion' ? c : it.pair?.kind === 'insertion' ? it.pair : null;
            return (
              <div key={key} ref={(el) => (el ? cardRefs.current.set(key, el) : cardRefs.current.delete(key))} className={`rv-card change ${c.author === AI_AUTHOR ? 'ai' : ''} ${isActive ? 'active' : ''}`} style={{ top: tops[key] ?? 0 }} onMouseDown={() => setActive(it.id)}>
                <div className="rv-who">
                  <Avatar name={c.author || 'Someone'} />
                  <div className="rv-meta">
                    <b>{c.author || 'Someone'}</b>
                    <span>{timeAgo(c.at)}</span>
                  </div>
                  <button className="icon-btn sm" title="Accept" onClick={(e) => (e.stopPropagation(), resolveChanges(editor, true, c.id))}>
                    <Check size={15} />
                  </button>
                  <button className="icon-btn sm" title="Reject" onClick={(e) => (e.stopPropagation(), resolveChanges(editor, false, c.id))}>
                    <X size={15} />
                  </button>
                </div>
                <div className="rv-change">
                  {del && ins ? (
                    <>
                      Replace: <del>{del.text.slice(0, 120)}</del> with <ins>{ins.text.slice(0, 120)}</ins>
                    </>
                  ) : del ? (
                    <>
                      Delete: <del>{del.text.slice(0, 160)}</del>
                    </>
                  ) : (
                    <>
                      Add: <ins>{ins!.text.slice(0, 160)}</ins>
                    </>
                  )}
                </div>
              </div>
            );
          }
          const t = it.thread;
          const isDraft = it.id === draftId && !t.text;
          return (
            <div
              key={key}
              ref={(el) => (el ? cardRefs.current.set(key, el) : cardRefs.current.delete(key))}
              className={`rv-card ${isAiAuthor(t.author) ? 'ai' : ''} ${isActive || isDraft ? 'active' : ''} ${t.resolved ? 'resolved' : ''}`}
              style={{ top: tops[key] ?? 0 }}
              onMouseDown={() => setActive(it.id)}
            >
              {isDraft ? (
                <>
                  <div className="rv-who">
                    <Avatar name={me} />
                    <div className="rv-meta">
                      <b>{me}</b>
                    </div>
                  </div>
                  <textarea
                    className="rv-input"
                    autoFocus
                    placeholder="Comment…"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && draft.trim()) {
                        setThreads((l) => [...l, { id: it.id, author: me, text: draft.trim(), at: Date.now(), replies: [] }]);
                        onDraftDone();
                      }
                      if (e.key === 'Escape') {
                        editor.commands.removeComment(it.id);
                        onDraftDone();
                      }
                    }}
                  />
                  <div className="rv-actions">
                    <button
                      className="btn sm"
                      onClick={() => {
                        editor.commands.removeComment(it.id);
                        onDraftDone();
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      className="btn sm primary"
                      disabled={!draft.trim()}
                      onClick={() => {
                        setThreads((l) => [...l, { id: it.id, author: me, text: draft.trim(), at: Date.now(), replies: [] }]);
                        onDraftDone();
                      }}
                    >
                      Comment
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="rv-who">
                    <Avatar name={t.author} />
                    <div className="rv-meta">
                      <b>{t.author}</b>
                      <span>{timeAgo(t.at)}</span>
                    </div>
                    <button
                      className="icon-btn sm"
                      title={t.resolved ? 'Re-open' : 'Resolve'}
                      onClick={(e) => {
                        e.stopPropagation();
                        setThreads((l) => l.map((x) => (x.id === t.id ? { ...x, resolved: !x.resolved } : x)));
                        setActive(null);
                      }}
                    >
                      {t.resolved ? <Undo2 size={15} /> : <Check size={15} />}
                    </button>
                    <span onMouseDown={(e) => e.stopPropagation()}>
                      <MenuButton
                        align="right"
                        button={() => (
                          <button className="icon-btn sm">
                            <MoreVertical size={15} />
                          </button>
                        )}
                      >
                        {(close) => (
                          <>
                            {t.author === me && (
                              <button className="menu-item" onClick={() => (setEditingId(t.id), setDraft(t.text), close())}>
                                Edit
                              </button>
                            )}
                            <button className="menu-item" onClick={() => (removeThread(t.id), close())}>
                              Delete thread
                            </button>
                          </>
                        )}
                      </MenuButton>
                    </span>
                  </div>
                  {editingId === t.id ? (
                    <>
                      <textarea className="rv-input" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} />
                      <div className="rv-actions">
                        <button className="btn sm" onClick={() => setEditingId(null)}>
                          Cancel
                        </button>
                        <button
                          className="btn sm primary"
                          onClick={() => {
                            setThreads((l) => l.map((x) => (x.id === t.id ? { ...x, text: draft.trim() || x.text } : x)));
                            setEditingId(null);
                          }}
                        >
                          Save
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="rv-text">{t.text}</div>
                  )}
                  {t.replies.map((r) => (
                    <div key={r.id} className="rv-reply">
                      <div className="rv-who">
                        <Avatar name={r.author} />
                        <div className="rv-meta">
                          <b>{r.author}</b>
                          <span>{timeAgo(r.at)}</span>
                        </div>
                      </div>
                      <div className="rv-text">{r.text}</div>
                    </div>
                  ))}
                  {isActive && !t.resolved && editingId !== t.id && (
                    <div className="rv-replybox">
                      <input
                        className="input sm"
                        placeholder="Reply…"
                        value={reply}
                        onChange={(e) => setReply(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && reply.trim()) {
                            setThreads((l) => l.map((x) => (x.id === t.id ? { ...x, replies: [...x.replies, { id: uid(), author: me, text: reply.trim(), at: Date.now() }] } : x)));
                            setReply('');
                          }
                        }}
                      />
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
