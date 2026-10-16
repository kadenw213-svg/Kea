import { useEffect, useRef, useState } from 'react';
import { BookOpen, BookA, Lightbulb, X, Settings2, Trash2, Globe, ExternalLink, Copy, ArrowDownToLine, Feather, ChevronDown, ChevronUp, WifiOff } from 'lucide-react';
import { openSettings, setting, useSettings } from '../../lib/settings';
import { useTabs, editorRegistry, toast } from '../../store';
import { uid } from '../../lib/util';
import { explainTerm, explainSimpler, termsIn, defineWord, contextAround, wholeWords, warmUp, termPattern, ExplainResult } from '../../lib/lookup';
import type { DictEntry } from '../../lib/api';
import { useLookup, setLookupOpen, LookupCard } from './lookupStore';
import '../../styles/ai.css';
import '../../styles/lookup.css';

/** The Encyclopedia panel (Ctrl+J): explain a term from Wikipedia, or define a word (Wiktionary, or the offline dictionary). */
export function LookupPanel() {
  const lk = useLookup();
  const activeId = useTabs((s) => s.activeId);
  const hooks = editorRegistry.get(activeId)?.ai;
  const selection = lk.selections[activeId] || '';
  const [query, setQuery] = useState('');
  const typed = useRef(false);
  const [online, setOnline] = useState(navigator.onLine);

  // The box follows your highlight (until you type in it yourself).
  useEffect(() => {
    if (!selection) return;
    typed.current = false;
    setQuery(selection.length > 300 ? selection.slice(0, 300) : selection);
  }, [selection]);
  useEffect(() => {
    if (lk.open) warmUp();
  }, [lk.open]);
  useEffect(() => {
    const on = () => setOnline(navigator.onLine);
    window.addEventListener('online', on);
    window.addEventListener('offline', on);
    return () => (window.removeEventListener('online', on), window.removeEventListener('offline', on));
  }, []);

  const patch = (id: string, p: Partial<LookupCard>) => useLookup.getState().set({ cards: useLookup.getState().cards.map((c) => (c.id === id ? { ...c, ...p } : c)) });
  const add = (c: LookupCard) => useLookup.getState().set({ cards: [c, ...useLookup.getState().cards].slice(0, 40) });
  const docText = async () => (hooks ? (await hooks.getDocument().catch(() => ({ full: '' }))).full : '');
  const context = async (text: string) => contextAround(await docText(), text);

  const explain = async (text = query, forceTitle?: string) => {
    let t = text.replace(/\s+/g, ' ').trim();
    if (!t) return toast('Highlight a word or phrase, or type one.');
    if (!navigator.onLine) return toast('Explain reads Wikipedia, so it needs the internet. Dictionary works offline.');
    const full = await docText();
    // A highlight that cut a word off gets its whole words back from the document ("polar dissolves pol").
    if (!forceTitle && !typed.current && setting('lookup.mendInput') !== false) {
      const whole = wholeWords(full, t);
      if (whole !== t) setQuery((t = whole));
    }
    const ctx = contextAround(full, t);
    const terms = forceTitle ? [t] : await termsIn(t);
    for (const term of terms) {
      const id = uid();
      add({ id, kind: 'explain', query: term, loading: true, status: 'Searching Wikipedia…' });
      try {
        const r = await explainTerm(term, ctx, (status) => patch(id, { status }), forceTitle);
        patch(id, r ? { loading: false, explain: r, query: r.term } :{ loading: false, error: `Wikipedia has no article for “${term}”. Check the spelling, or try a shorter term.` });
      } catch (err: any) {
        patch(id, { loading: false, error: /abort|fetch|network|answer/i.test(String(err?.message)) ? 'Wikipedia didn’t answer. Check your internet connection and try again.' : String(err?.message || err) });
      }
    }
  };
  const define = async (text = query) => {
    const t = text.replace(/\s+/g, ' ').trim();
    if (!t) return toast('Highlight a word, or type one.');
    const id = uid();
    add({ id, kind: 'define', query: t, loading: true });
    patch(id, { loading: false, define: await defineWord(t).catch(() => null) });
  };
  const simpler = async (card: LookupCard) => {
    if (!card.explain) return;
    const id = uid();
    add({ id, kind: 'explain', query: card.query, loading: true, status: 'Looking in Simple English Wikipedia…' });
    const r = await explainSimpler(card.explain, await context(card.query), (status) => patch(id, { status })).catch(() => null);
    patch(id, r ? { loading: false, explain: r } : { loading: false, error: `Simple English Wikipedia has no article on “${card.explain.page.title}”.` });
  };

  // Alt+1 Explain, Alt+2 Dictionary.
  useEffect(() => {
    if (!lk.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || !['1', '2'].includes(e.key)) return;
      e.preventDefault();
      if (e.key === '1') explain();
      else define();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = Number(useSettings.getState().values['ai.sidebarWidth']) || 380;
    document.body.classList.add('col-resizing');
    const move = (ev: PointerEvent) => useSettings.getState().set({ 'ai.sidebarWidth': Math.round(Math.min(640, Math.max(300, startW + (startX - ev.clientX)))) });
    const up = () => {
      document.body.classList.remove('col-resizing');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // Highlighting text inside a result puts it in the box, so you can follow up on any word or concept.
  const followUp = () => {
    const t = window.getSelection()?.toString().replace(/\s+/g, ' ').trim();
    if (t && t.length < 300) {
      typed.current = true;
      setQuery(t);
    }
  };

  const insert = (md: string) => (hooks?.insertText?.(md) ? toast('Inserted. Ctrl+Z to undo.', 'success') : toast('Click in your document where it should go first.'));

  return (
    <aside className={`ai-sidebar lookup ${lk.open ? 'open' : ''}`} aria-hidden={!lk.open}>
      <div className="ai-resize" title="Drag to resize" onPointerDown={startResize} onDoubleClick={() => useSettings.getState().set({ 'ai.sidebarWidth': 380 })} />
      <div className="ai-inner">
        <div className="ai-head">
          <div className="ai-title">
            <BookOpen size={17} />
            <span>Encyclopedia</span>
          </div>
          <div style={{ display: 'flex' }}>
            {lk.cards.length > 0 && (
              <button className="icon-btn sm" title="Clear results" onClick={() => lk.set({ cards: [] })}>
                <Trash2 size={15} />
              </button>
            )}
            <button className="icon-btn sm" title="Encyclopedia settings" onClick={() => openSettings('lookup')}>
              <Settings2 size={15} />
            </button>
            <button className="icon-btn sm" title="Close (Ctrl+J)" onClick={() => setLookupOpen(false)}>
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="lk-search">
          <input
            className="input"
            value={query}
            placeholder="Highlight or type a word, term or idea"
            onChange={(e) => ((typed.current = true), setQuery(e.target.value))}
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), explain())}
          />
          <div className="lk-actions">
            <button className="btn sm tonal" onClick={() => explain()} title="Explain it from Wikipedia (Enter · Alt+1)">
              <Lightbulb size={14} /> Explain
            </button>
            <button className="btn sm tonal" onClick={() => define()} title="Definitions, synonyms and antonyms (Alt+2)">
              <BookA size={14} /> Dictionary
            </button>
          </div>
          {!online && (
            <div className="lk-offline">
              <WifiOff size={13} /> Offline: Dictionary works; Explain needs the internet.
            </div>
          )}
        </div>

        <div className="ai-list lk-list" onMouseUp={followUp}>
          {!lk.cards.length && (
            <div className="ai-empty">
              <BookOpen size={28} />
              <div>Highlight a word or idea you don’t know, then choose Explain or Dictionary.</div>
              <div className="muted">Explanations are Wikipedia’s own words and definitions are Wiktionary’s, with links. Offline, the dictionary still works. Highlight anything in a result to look that up too.</div>
            </div>
          )}
          {lk.cards.map((c) => (
            <div key={c.id} className="lk-card">
              {c.loading ? (
                <div className="ai-status">
                  <span className="dot-pulse" /> {c.status || 'Looking it up…'}
                </div>
              ) : c.error ? (
                <div className="lk-error">{c.error}</div>
              ) : c.kind === 'explain' && c.explain ? (
                <ExplainView r={c.explain} onSimpler={() => simpler(c)} onOther={(title) => explain(c.query, title)} onInsert={insert} canInsert={!!hooks?.insertText} />
              ) : c.kind === 'define' ? (
                <DefineView query={c.query} d={c.define || null} onWord={(w) => define(w)} onExplain={() => explain(c.query)} onInsert={insert} canInsert={!!hooks?.insertText} />
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}

function Para({ text }: { text: string }) {
  return (
    <>
      {text.split(/\n\n+/).map((p, i) => (
        <p key={i}>{p}</p>
      ))}
    </>
  );
}

/** A paragraph with the highlighted term in bold wherever it's used. */
function Marked({ text, term }: { text: string; term: string }) {
  const re = termPattern(term);
  const out: React.ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(re)) {
    out.push(text.slice(at, m.index), <strong key={m.index}>{m[0]}</strong>);
    at = m.index! + m[0].length;
  }
  out.push(text.slice(at));
  return <>{out}</>;
}

function Section({ title, text }: { title: string; text: string }) {
  const paras = text.split(/\n\n+/);
  const [open, setOpen] = useState(false);
  return (
    <div className="lk-section">
      <div className="lk-sec-title">{title}</div>
      <Para text={open ? text : paras[0]} />
      {paras.length > 1 && (
        <button className="link-btn lk-more" onClick={() => setOpen(!open)}>
          {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />} {open ? 'Show less' : `Show all of “${title}”`}
        </button>
      )}
    </div>
  );
}

function ExplainView({ r, onSimpler, onOther, onInsert, canInsert }: { r: ExplainResult; onSimpler(): void; onOther(title: string): void; onInsert(md: string): void; canInsert: boolean }) {
  const [more, setMore] = useState(false);
  const source = `Wikipedia${r.lang === 'simple' ? ' (Simple English)' : ''}, “${r.page.title}”`;
  const asText = () => [`${r.page.title}`, ...r.focus.map((f) => f.text), r.definition,...r.sections.map((s) => `${s.title}\n${s.text}`), `Source: ${source} ${r.page.url}`].join('\n\n');
  return (
    <>
      <div className="lk-head">
        <div className="lk-term">{r.page.title}</div>
        <a className="wiki-chip" href={r.page.url} target="_blank" rel="noreferrer" title={`Open the article${r.page.edited ? ` (last edited ${r.page.edited.slice(0, 10)})` : ''}`}>
          <Globe size={12} /> {r.lang === 'simple' ? 'Simple Wikipedia' : 'Wikipedia'} <ExternalLink size={11} />
        </a>
      </div>
      {r.page.description && <div className="lk-desc">{r.page.description}</div>}
      {r.asked && r.asked.toLowerCase() !== r.term.toLowerCase() && (
        <div className="lk-desc muted">
          Looked up “{r.term}” (you highlighted “{r.asked}”)
        </div>
      )}
      <div className="lk-body">
        {r.focus.length > 0 && (
          <div className="lk-focus">
            <div className="lk-sec-title">
              “{r.term}” in this article{r.focus[0].section ? <span className="muted"> · {r.focus[0].section}</span> : null}
            </div>
            {r.focus.map((f, i) => (
              <div key={i}>
                {i > 0 && f.section && f.section !== r.focus[i - 1].section && <div className="lk-focus-sec muted">{f.section}</div>}
                {f.text.split(/\n\n+/).map((p, k) => (
                  <p key={k}>
                    <Marked text={p} term={r.term} />
                  </p>
                ))}
              </div>
            ))}
          </div>
        )}
        {r.focus.length > 0 && <div className="lk-sec-title">{r.page.title}</div>}
        <Para text={r.definition} />
        {r.more && (
          <>
            {more && <Para text={r.more} />}
            <button className="link-btn lk-more" onClick={() => setMore(!more)}>
              {more ? <ChevronUp size={13} /> : <ChevronDown size={13} />} {more ? 'Show less' : 'Read the whole introduction'}
            </button>
          </>
        )}
        {r.sections.map((s) => (
          <Section key={s.title} title={s.title} text={s.text} />
        ))}
      </div>
      {r.others.length > 0 && (
        <div className="lk-others">
          <span className="muted">Not the right meaning?</span>
          {r.others.map((o) => (
            <button key={o.title} className="lk-chip" title={o.description || o.intro.slice(0, 160)} onClick={() => onOther(o.title)}>
              {o.title}
            </button>
          ))}
        </div>
      )}
      <div className="ai-actions">
        {r.lang !== 'simple' && (
          <button className="btn sm" onClick={onSimpler} title="The same topic from Simple English Wikipedia: shorter sentences, everyday words">
            <Feather size={13} /> Simpler
          </button>
        )}
        {canInsert && (
          <button className="btn sm" onClick={() => onInsert(r.focus.length ? `**${r.term}**: ${r.focus[0].text}\n\n_Source: ${source}_` : `**${r.page.title}**: ${r.definition.split('\n\n')[0]}\n\n_Source: ${source}_`)} title="Put the definition into your document, with its source">
            <ArrowDownToLine size={13} /> Insert
          </button>
        )}
        <button className="icon-btn sm" title="Copy" onClick={() => navigator.clipboard.writeText(asText()).then(() => toast('Copied', 'success'))}>
          <Copy size={14} />
        </button>
      </div>
    </>
  );
}

function DefineView({ query, d, onWord, onExplain, onInsert, canInsert }: { query: string; d: DictEntry | null; onWord(w: string): void; onExplain(): void; onInsert(md: string): void; canInsert: boolean }) {
  if (!d)
    return (
      <div className="lk-error">
        “{query}” isn’t in the dictionary. For names, places and technical terms, try Explain.
        <div className="ai-actions">
          <button className="btn sm tonal" onClick={onExplain}>
            <Lightbulb size={13} /> Explain instead
          </button>
        </div>
      </div>
    );
  const first = d.entries.find((e) => e.senses.some((s) => !s.formOf)) || d.entries[0];
  const firstSense = first.senses.find((s) => !s.formOf) || first.senses[0];
  const wiki = d.source === 'wiktionary';
  const chips = (list: string[]) =>
    list.map((w) => (
      <button key={w} className="lk-chip" onClick={() => onWord(w)} title={`Look up “${w}”`}>
        {w}
      </button>
    ));
  const asText = () =>
    [
      d.word,
      ...d.entries.map(
        (e) =>
          `${e.pos}${e.lemma !== d.word ? ` (${e.lemma})` : ''}\n${e.senses
            .map((s, i) => [`${i + 1}. ${s.label ? `(${s.label}) ` : ''}${s.def}`, ...(s.sub || []).map((x) => `   - ${x}`), ...s.examples.map((x) => `   “${x}”`)].join('\n'))
            .join('\n')}`
      ),
      wiki ? `Source: Wiktionary, “${d.word}” ${d.url}` : ''
    ]
      .filter(Boolean)
      .join('\n\n');
  return (
    <>
      <div className="lk-head">
        <div className="lk-term">{d.word}</div>
        {wiki ? (
          <a className="wiki-chip" href={d.url} target="_blank" rel="noreferrer" title="Open the entry on Wiktionary">
            <Globe size={12} /> Wiktionary <ExternalLink size={11} />
          </a>
        ) : (
          <span className="lk-src muted">Dictionary</span>
        )}
      </div>
      {d.entries.map((e, k) => (
        <div key={k} className="lk-pos">
          <div className="lk-pos-name">
            {e.pos}
            {e.lemma.toLowerCase() !== d.word.toLowerCase() && <span className="muted"> · {e.lemma}</span>}
          </div>
          <ol>
            {e.senses.map((s, i) =>
              s.formOf ? (
                <li key={i} className="lk-formof">
                  {s.def}{' '}
                  <button className="lk-chip" onClick={() => onWord(s.formOf!)} title={`Look up “${s.formOf}”`}>
                    {s.formOf}
                  </button>
                </li>
              ) : (
                <li key={i}>
                  <div>
                    {s.label && <span className="lk-label">{s.label}</span>}
                    {s.def}
                  </div>
                  {s.sub && s.sub.length > 0 && (
                    <ol className="lk-sub">
                      {s.sub.map((x, j) => (
                        <li key={j}>{x}</li>
                      ))}
                    </ol>
                  )}
                  {s.examples.map((x, j) => (
                    <div key={j} className="lk-ex">
                      “<Marked text={x} term={e.lemma} />”
                    </div>
                  ))}
                  {s.synonyms.length > 0 && <div className="lk-rel">Synonyms: {chips(s.synonyms)}</div>}
                  {s.antonyms.length > 0 && <div className="lk-rel">Opposites: {chips(s.antonyms)}</div>}
                </li>
              )
            )}
          </ol>
        </div>
      ))}
      {wiki && d.synonyms.length > 0 && <div className="lk-rel lk-rel-all">Synonyms: {chips(d.synonyms.slice(0, 14))}</div>}
      {wiki && d.antonyms.length > 0 && <div className="lk-rel lk-rel-all">Opposites: {chips(d.antonyms.slice(0, 10))}</div>}
      <div className="ai-actions">
        {canInsert && (
          <button className="btn sm" onClick={() => onInsert(`**${d.word}** (${first.pos}): ${firstSense.def}${firstSense.examples[0] ? ` _“${firstSense.examples[0]}”_` : ''}${wiki ? '\n\n_Source: Wiktionary_' : ''}`)} title="Add this word and its main meaning to your document (for a vocabulary list)">
            <ArrowDownToLine size={13} /> Insert
          </button>
        )}
        <button className="icon-btn sm" title="Copy" onClick={() => navigator.clipboard.writeText(asText()).then(() => toast('Copied', 'success'))}>
          <Copy size={14} />
        </button>
      </div>
    </>
  );
}
