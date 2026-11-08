// Settings: a calm first page that asks what the person is looking for and shows just those settings, a short list of
// the everyday ones, and seven categories. Every setting is still reachable (Advanced shows the rest of each page).
import { Logo } from '../Logo';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Circle, Clapperboard, Sparkles, Cloud, FileCode2, FileText, FileType2, GraduationCap, Home, Info, Mic, Palette, Plug, Presentation, RefreshCw, Save, Settings, Sheet, Shield, SpellCheck, Wand2, UserCircle, ChevronRight, ArrowRight, Loader2 } from 'lucide-react';

// Only the icons the sections use (importing the whole icon set put ~1,500 icons into Kea's start-up code).
const Icons = { BookOpen, Circle, Clapperboard, Sparkles, Cloud, FileCode2, FileText, FileType2, GraduationCap, Home, Info, Mic, Palette, Plug, Presentation, RefreshCw, Save, Settings, Sheet, Shield, SpellCheck, Wand2, UserCircle };
import { X, Search, RotateCcw, FolderOpen, ExternalLink } from 'lucide-react';
import { SECTIONS, Field, Section, useSettings, DEFAULTS } from '../../lib/settings';
import { CATEGORIES, POPULAR, Hit, categoryOf, sectionById, searchSettings, suggestChange, hintOf, modelAvailable, askModel } from '../../lib/settingsSearch';
import { api } from '../../lib/api';
import { ModelSettings } from '../lookup/ModelSettings';
import { toast, ask, useTabs, editorRegistry } from '../../store';
import { formatBytes } from '../../lib/util';
import { SHORTCUTS } from './shortcuts';
import { GooglePanel } from './GooglePanel';
import { useUpdates, openUpdates } from '../Updates';
import { useKeaModes } from '../../lib/modes';
import { VoiceSettingsExtras } from '../VoiceTyping';
import { FeedbackPanel } from './FeedbackPanel';
import { ControlPanel } from '../control/ControlPanel';
import { AiModelsPanel } from './AiModelsPanel';
import { KeaAccountSettings } from './KeaAccountSettings';
import { SyncLine } from './SyncPicker';
import { KeaCloudPanel } from '../home/KeaCloud';
import { Fold, FoldGroup } from '../Fold';
import { setFold } from '../../lib/folds';

function FieldControl({ f, value, onChange }: { f: Field; value: any; onChange: (v: any) => void }) {
  switch (f.type) {
    case 'toggle':
      return (
        <button role="switch" aria-checked={!!value} className={`switch ${value ? 'on' : ''}`} onClick={() => onChange(!value)}>
          <span />
        </button>
      );
    case 'select':
      return (
        <select className="select" value={String(value)} onChange={(e) => onChange(f.options!.find((o) => String(o.value) === e.target.value)!.value)}>
          {f.options!.map((o) => (
            <option key={String(o.value)} value={String(o.value)}>
              {o.label}
            </option>
          ))}
        </select>
      );
    case 'number':
      return (
        <span className="num-field">
          <input
            className="input sm"
            type="number"
            value={value}
            min={f.min}
            max={f.max}
            step={f.step || 1}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (e.target.value !== '' && !Number.isNaN(n)) onChange(Math.min(f.max ?? Infinity, Math.max(f.min ?? -Infinity, n)));
            }}
          />
          {f.unit && <span className="muted">{f.unit}</span>}
        </span>
      );
    case 'range':
      return (
        <span className="num-field">
          <input type="range" min={f.min} max={f.max} step={f.step || 1} value={value} onChange={(e) => onChange(Number(e.target.value))} />
          <span className="muted" style={{ width: 34, textAlign: 'right' }}>
            {value}
          </span>
        </span>
      );
    case 'color':
      return <input type="color" className="color-field" value={value} onChange={(e) => onChange(e.target.value)} />;
    case 'folder':
      return (
        <span className="num-field">
          <input className="input sm" style={{ width: 220 }} value={value} placeholder="Documents" onChange={(e) => onChange(e.target.value)} />
          <button
            className="icon-btn sm"
            title="Choose folder"
            onClick={async () => {
              const d = await api.openFolderDialog();
              if (d) onChange(d);
            }}
          >
            <FolderOpen size={15} />
          </button>
        </span>
      );
    default:
      return <input className="input sm" style={{ width: 240 }} value={value} onChange={(e) => onChange(e.target.value)} />;
  }
}

const setValue = (f: Field, v: any) => {
  useSettings.getState().set({ [f.key]: v });
  if (f.restart) toast('This takes effect after you restart Kea.');
};

/**
 * One setting: its name, a one-line hint (the whole help text on request) and its control. In search results it also
 * says where it lives and may offer the change the request asked for, applied only when clicked.
 */
function Row({ f, where, onWhere, q, compact }: { f: Field; where?: string; onWhere?: () => void; q?: string; compact?: boolean }) {
  const value = useSettings((s) => (s.values[f.key] === undefined ? f.default : s.values[f.key]));
  const changed = JSON.stringify(value) !== JSON.stringify(DEFAULTS[f.key]);
  const [open, setOpen] = useState(false);
  const { hint, more } = compact ? { hint: '', more: false } : hintOf(f.help);
  const sug = q ? suggestChange(q, f, value) : null;
  return (
    <div className={`srow ${f.advanced ? 'adv' : ''}`}>
      <div className="srow-text">
        {where && (
          <button className="srow-where" onClick={onWhere} title="Go to this page of Settings">
            {where} <ChevronRight size={12} />
          </button>
        )}
        <div className="srow-label">
          {f.label}
          {f.restart && <span className="sbadge">restart</span>}
          {f.advanced && <span className="sbadge adv">advanced</span>}
        </div>
        {hint && (
          <div className={`srow-help ${open ? 'open' : ''}`}>
            <span className="srow-hint">{open ? f.help : hint}</span>
            {more && (
              <button className="srow-more" onClick={() => setOpen(!open)}>
                {open ? 'Less' : 'More'}
              </button>
            )}
          </div>
        )}
      </div>
      <div className="srow-ctl">
        {sug && (
          <button className="btn sm sugg" title="Suggested from what you typed" onClick={() => setValue(f, sug.value)}>
            {sug.label}
          </button>
        )}
        {changed && (
          <button className="icon-btn sm reset" title="Reset to default" onClick={() => setValue(f, f.default)}>
            <RotateCcw size={13} />
          </button>
        )}
        <FieldControl f={f} value={value} onChange={(v) => setValue(f, v)} />
      </div>
    </div>
  );
}

function FilesExtras() {
  const [usage, setUsage] = useState<number | null>(null);
  useEffect(() => {
    api.history.usage().then(setUsage);
  }, []);
  return (
    <div className="sextras">
      <div className="muted">Version history uses {usage == null ? '…' : formatBytes(usage)} on this PC.</div>
      <button className="btn sm" onClick={() => api.history.openFolder()}>
        <FolderOpen size={14} /> Open folder
      </button>
      <button
        className="btn sm danger"
        onClick={async () => {
          if ((await ask('Delete all version history?', 'Earlier versions of every file will be deleted. Your files themselves are not touched.', [{ id: 'cancel', label: 'Cancel' }, { id: 'del', label: 'Delete', danger: true, primary: true }])) !== 'del') return;
          await api.history.clear();
          setUsage(0);
          toast('Version history cleared', 'success');
        }}
      >
        Delete all versions
      </button>
    </div>
  );
}

function PrivacyExtras() {
  const clear = async (label: string, fn: () => Promise<any>) => {
    await fn();
    toast(`${label} cleared`, 'success');
  };
  return (
    <div className="sextras col">
      <button className="btn sm" onClick={() => clear('Recent files', () => api.clearRecent())}>
        Clear recent files
      </button>
      <button className="btn sm" onClick={() => clear('File previews', () => api.clearPreviews())}>
        Clear saved previews
      </button>
      <button className="btn sm" onClick={() => clear('Descriptions', () => api.clearMeta())}>
        Clear file descriptions
      </button>
      <button className="btn sm" onClick={() => api.openDataFolder()}>
        <FolderOpen size={14} /> Open Kea's data folder
      </button>
    </div>
  );
}

function ShortcutsPanel({ q }: { q: string }) {
  const list = SHORTCUTS.map((g) => ({ ...g, items: g.items.filter(([k, d]) => !q || (k + ' ' + d).toLowerCase().includes(q)) })).filter((g) => g.items.length);
  return (
    <div className="shortcuts">
      {list.map((g) => (
        <div key={g.group} className="sc-group">
          <div className="sc-head">{g.group}</div>
          {g.items.map(([keys, desc]) => (
            <div key={keys + desc} className="sc-row">
              <span>{desc}</span>
              <span className="sc-keys">
                {keys.split(' / ').map((alt, i) => (
                  <span key={i}>
                    {i > 0 && <span className="muted"> or </span>}
                    {alt.split('+').map((k, j) => (
                      <span key={j}>
                        {j > 0 && '+'}
                        <kbd>{k}</kbd>
                      </span>
                    ))}
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Open a text file that ships inside the app (licenses) in a Kea tab. */
async function openBundled(rel: string) {
  const res = await fetch(`./${rel}`);
  const data = new Uint8Array(await res.arrayBuffer());
  const name = rel.split('/').pop()!.replace(/\.md$/, '.txt');
  useTabs.getState().addTab({ kind: 'code', name, path: null, data });
  useSettings.getState().ui({ open: false });
}

function AboutPanel() {
  const version = useUpdates((s) => s.version);
  return (
    <div className="about">
      <div className="about-hero">
        <Logo size={56} />
        <div>
          <div className="about-name">Kea {version}</div>
          <div className="muted">A study app and office suite in one. Free and open source under the MIT license.</div>
        </div>
      </div>
      <div className="about-card">
        <div className="about-title">Built with Llama</div>
        <p>
          The "Balanced" picking model is Llama 3.2. Llama 3.2 is licensed under the Llama 3.2 Community License, Copyright © Meta Platforms, Inc. All Rights Reserved. The "Light" and "Best" models
          are Qwen2.5 by Alibaba Cloud, under the Apache License 2.0. Voice typing uses OpenAI Whisper (MIT licence) with Transformers.js and ONNX Runtime. Models run entirely on this computer.
        </p>
        <div className="about-links">
          <a href="#" onClick={(e) => (e.preventDefault(), openBundled('licenses/LLAMA-3.2-LICENSE.txt'))}>
            Llama 3.2 license <ExternalLink size={12} />
          </a>
          <a href="#" onClick={(e) => (e.preventDefault(), openBundled('licenses/LLAMA-3.2-USE-POLICY.md'))}>
            Llama acceptable use policy <ExternalLink size={12} />
          </a>
        </div>
      </div>
      <div className="about-card">
        <div className="about-title">Open-source software</div>
        <p>Kea is built on hundreds of open-source projects, including Electron, React, pdf.js, pdf-lib, TipTap, ExcelJS, SheetJS, PptxGenJS, CodeMirror, llama.cpp and node-llama-cpp. Their licenses and copyright notices are included with the app.</p>
        <div className="about-links">
          <a href="#" onClick={(e) => (e.preventDefault(), openBundled('licenses/third-party.txt'))}>
            Third-party licenses <ExternalLink size={12} />
          </a>
          <a href="https://github.com/kadenw213-svg/kea" target="_blank">
            Source code <ExternalLink size={12} />
          </a>
        </div>
      </div>
      <div className="about-card">
        <div className="about-title">Trademarks</div>
        <p>Microsoft, Word, Excel, PowerPoint and OneDrive are trademarks of Microsoft. Google Drive and Google Docs are trademarks of Google LLC. Dropbox is a trademark of Dropbox, Inc. iCloud is a trademark of Apple Inc. Kea isn't affiliated with or endorsed by any of them.</p>
      </div>
    </div>
  );
}

const where = (s: Section) => {
  const c = categoryOf(s.id);
  return c.sections.length > 1 && s.label !== c.label ? `${c.label} › ${s.label}` : c.label;
};

/** A search result that's a page or a panel rather than one setting. */
function PanelRow({ hit, go }: { hit: Extract<Hit, { kind: 'panel' }>; go: (id: string) => void }) {
  const p = hit.panel;
  // An action ("Check for updates now", "Print the open file") runs right away; the rest open their page.
  const run = () => {
    if (p.action === 'checkUpdates') {
      useSettings.getState().ui({ open: false });
      openUpdates(true);
    } else if (p.action === 'print') {
      const handle = editorRegistry.get(useTabs.getState().activeId);
      if (!handle?.print) return toast('Open a document, sheet, slide or PDF to print it.');
      useSettings.getState().ui({ open: false });
      handle.print();
    } else go(hit.section.id);
  };
  return (
    <button className="srow srow-link" onClick={run}>
      <div className="srow-text">
        <span className="srow-where">{where(hit.section)}</span>
        <div className="srow-label">{p.label}</div>
        {p.hint && <div className="srow-help">{p.hint}</div>}
      </div>
      <ArrowRight size={16} className="muted" />
    </button>
  );
}

function HitRows({ hits, q, go, strong = 0 }: { hits: Hit[]; q: string; go: (id: string) => void; strong?: number }) {
  // A suggested change only on the closest matches (a weak match saying "Turn off" would be noise).
  return (
    <>
      {hits.map((h) =>
        h.kind === 'field' ? (
          <Row key={h.key} f={h.field} q={h.score >= strong ? q : undefined} where={where(h.section)} onWhere={() => (openGroupOf(h.section, h.field.key), go(h.section.id))} />
        ) : (
          <PanelRow key={h.key} hit={h} go={go} />
        )
      )}
    </>
  );
}

/** Settings' first page: "What are you looking for?", the everyday settings, and the categories. */
function SettingsStart({ q, setQ, go }: { q: string; setQ: (q: string) => void; go: (id: string) => void }) {
  const values = useSettings((s) => s.values);
  const query = q.trim();
  const hits = useMemo(() => (query ? searchSettings(query, { values }) : []), [query, values]);
  const [all, setAll] = useState(false);
  const [canAsk, setCanAsk] = useState(false);
  const [ai, setAi] = useState<{ q: string; hits: Hit[] | null; busy: boolean } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    modelAvailable().then(setCanAsk);
  }, []);
  useEffect(() => {
    setAll(false);
  }, [query]);

  const askKea = async () => {
    if (!query || !canAsk) return;
    setAi({ q: query, hits: null, busy: true });
    const picks = await askModel(query, values);
    setAi((cur) => (cur && cur.q === query ? { q: query, hits: picks, busy: false } : cur));
  };
  const aiNow = ai && ai.q === query ? ai : null;
  const aiKeys = new Set((aiNow?.hits || []).map((h) => h.key));
  const shortcuts = query.length > 1 ? SHORTCUTS.flatMap((g) => g.items.filter(([k, d]) => (k + ' ' + d).toLowerCase().includes(query.toLowerCase()))).slice(0, 4) : [];
  const rest = hits.filter((h) => !aiKeys.has(h.key));
  const shown = all ? rest : rest.slice(0, 7);
  // "Most used" follows the modes that are on: class-site notifications only for School.
  const modes = useKeaModes();
  const popular = POPULAR.map((k) => SECTIONS.flatMap((s) => s.fields).find((f) => f.key === k)).filter((f): f is Field => !!f && (!f.when || f.when(values)) && !(f.key.startsWith('scholar.') && !modes.school));

  return (
    <div className="sstart">
      <div className="sstart-hero">
        <h2>What are you looking for?</h2>
        <div className="sstart-box">
          <Search size={18} />
          <input
            ref={input}
            autoFocus
            placeholder="Try “dark mode”, “make text bigger” or “stop notifications”"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') askKea();
            }}
          />
          {q && (
            <button className="icon-btn sm" title="Clear" onClick={() => (setQ(''), input.current?.focus())}>
              <X size={15} />
            </button>
          )}
          {canAsk && query && (
            <button className="btn sm sstart-ask" onClick={askKea} disabled={!!aiNow?.busy} title="Kea’s local model reads your request and points out the settings for it. Nothing changes until you click.">
              {aiNow?.busy ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />} Ask
            </button>
          )}
        </div>
        {canAsk && query && !aiNow && <div className="sstart-tip">Press Enter to have Kea’s local model find it. Nothing changes until you click.</div>}
      </div>

      {query ? (
        <div className="sstart-results">
          {aiNow && !aiNow.busy && (
            <>
              <div className="sstart-sec">
                <Sparkles size={13} /> For “{aiNow.q}”
              </div>
              {aiNow.hits && aiNow.hits.length ? (
                <div className="sstart-list">
                  <HitRows hits={aiNow.hits} q={query} go={go} />
                </div>
              ) : (
                <div className="sstart-empty">{aiNow.hits ? 'The model didn’t find a setting for that. The closest word matches are below.' : 'The model didn’t answer in time. The closest word matches are below.'}</div>
              )}
            </>
          )}
          {rest.length > 0 && (
            <>
              {aiNow && <div className="sstart-sec">Other matches</div>}
              <div className="sstart-list">
                <HitRows hits={shown} q={query} go={go} strong={(rest[0]?.score ?? 0) * 0.6} />
              </div>
              {rest.length > shown.length && (
                <button className="link-btn sstart-more" onClick={() => setAll(true)}>
                  Show {rest.length - shown.length} more
                </button>
              )}
            </>
          )}
          {shortcuts.length > 0 && (
            <>
              <div className="sstart-sec">Keyboard shortcuts</div>
              <div className="sstart-list">
                {shortcuts.map(([keys, desc]) => (
                  <div key={keys + desc} className="srow">
                    <div className="srow-text">
                      <div className="srow-label">{desc}</div>
                    </div>
                    <span className="sc-keys">
                      {keys.split(' / ')[0].split('+').map((k, j) => (
                        <span key={j}>
                          {j > 0 && '+'}
                          <kbd>{k}</kbd>
                        </span>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
          {!rest.length && !shortcuts.length && !aiNow?.hits?.length && !aiNow?.busy && (
            <div className="sstart-empty">
              Nothing matches “{query}”.{canAsk ? ' Press Enter to ask Kea’s local model, or pick a category.' : ' Try other words, or pick a category.'}
              <div className="scat-mini">
                {CATEGORIES.map((c) => (
                  <button key={c.id} className="chip" onClick={() => go(c.sections[0])}>
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="sstart-sec">Most used</div>
          <div className="sstart-list">
            {popular.map((f) => {

              return <Row key={f.key} f={f} compact />;
            })}
          </div>
          <div className="sstart-sec">Everything else</div>
          <div className="scat-grid">
            {CATEGORIES.map((c) => {
              const Icon = (Icons as any)[c.icon] || Icons.Circle;
              return (
                <button key={c.id} className="scat-card" onClick={() => go(c.sections[0])}>
                  <span className="scat-icon">
                    <Icon size={18} />
                  </span>
                  <span className="scat-text">
                    <b>{c.label}</b>
                    <span>{c.blurb}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

/** The heading each field of a page sits under ('' before the first one). */
function groupsOf(cur: Section) {
  const groupOf = new Map<string, string>();
  let g = '';
  for (const f of cur.fields) groupOf.set(f.key, (g = f.group || g));
  return groupOf;
}
/** Going to a setting from a search result opens the group it's in. */
function openGroupOf(cur: Section, key: string) {
  const g = groupsOf(cur).get(key);
  if (g) setFold(`settings:${cur.id}`, g, true);
}

/**
 * One page of settings (a section), with its extra panels. A page with several groups folds them like every screen in
 * Kea: the first open, the rest closed until opened, each remembered.
 */
function SectionBody({ cur, showAdvanced }: { cur: Section; showAdvanced: boolean }) {
  const values = useSettings((s) => s.values);
  if (cur.id === 'shortcuts') return <ShortcutsPanel q="" />;
  if (cur.id === 'about') return <AboutPanel />;
  if (cur.id === 'feedback') return <FeedbackPanel />;
  const visible = cur.fields.filter((f) => (showAdvanced || !f.advanced) && (!f.when || f.when(values)));
  const advCount = cur.fields.filter((f) => f.advanced && (!f.when || f.when(values))).length;
  // Each field belongs to the group heading above it; a heading shows above the first visible field of its group.
  const groupOf = groupsOf(cur);
  const parts: { head: string; fields: Field[] }[] = [];
  for (const f of visible) {
    const head = groupOf.get(f.key) || '';
    if (parts.length && parts[parts.length - 1].head === head) parts[parts.length - 1].fields.push(f);
    else parts.push({ head, fields: [f] });
  }
  const folding = parts.filter((p) => p.head).length > 1;
  return (
    <>
      {cur.blurb && <p className="sblurb">{cur.blurb}</p>}
      {cur.id === 'google' && <GooglePanel />}
      {cur.id === 'control' && <ControlPanel />}
      {cur.id === 'aimodels' && <AiModelsPanel />}
      {cur.id === 'account' && <KeaAccountSettings />}
      {cur.id === 'keacloud' && <KeaCloudPanel />}
      <FoldGroup screen={`settings:${cur.id}`}>
        {parts.map((p, i) =>
          p.head && folding ? (
            <Fold key={`${p.head}:${i}`} id={p.head} className="sgroup-fold" title={<span className="sgroup-title">{p.head}</span>}>
              {p.fields.map((f) => (
                <Row key={f.key} f={f} />
              ))}
            </Fold>
          ) : (
            <Fragment key={`${p.head}:${i}`}>
              {p.head && <div className="sgroup-title sgroup-in">{p.head}</div>}
              {p.fields.map((f) => (
                <Row key={f.key} f={f} />
              ))}
            </Fragment>
          )
        )}
      </FoldGroup>
      {!showAdvanced && advCount > 0 && (
        <button className="link-btn more-adv" onClick={() => useSettings.getState().set({ 'ui.showAdvanced': true })}>
          Show {advCount} advanced setting{advCount === 1 ? '' : 's'}
        </button>
      )}
      {cur.id === 'files' && <FilesExtras />}
      {cur.id === 'voice' && <VoiceSettingsExtras />}
      {cur.id === 'privacy' && <PrivacyExtras />}
      {cur.id === 'lookup' && <ModelSettings />}
      {cur.id === 'scholar' && (
        <div className="sextras">
          <SyncLine onChange={() => useSettings.getState().ui({ section: 'keacloud' })} />
        </div>
      )}
    </>
  );
}

export function SettingsDialog() {
  const { open, section } = useSettings();
  const showAdvanced = useSettings((s) => !!s.values['ui.showAdvanced']);
  const [q, setQ] = useState('');
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    setQ('');
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        useSettings.getState().ui({ open: false });
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);
  useEffect(() => {
    // (Braces: in newer Chromium, scrollTo returns a promise, which an effect must not return.)
    body.current?.scrollTo(0, 0);
  }, [section]);

  if (!open) return null;
  const close = () => useSettings.getState().ui({ open: false });
  const go = (id: string) => useSettings.getState().ui({ section: id });
  const start = section === 'start' || !sectionById(section);
  const cur = start ? null : sectionById(section)!;
  const cat = cur ? categoryOf(cur.id) : null;

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog settings-dialog" role="dialog" aria-label="Settings">
        <nav className="snav">
          <div className="snav-title">Settings</div>
          <button className={`snav-item ${start ? 'on' : ''}`} onClick={() => go('start')}>
            <Search size={16} />
            Find a setting
          </button>
          <div className="snav-sep" />
          {CATEGORIES.map((c) => {
            const Icon = (Icons as any)[c.icon] || Icons.Circle;
            return (
              <button key={c.id} className={`snav-item ${cat?.id === c.id ? 'on' : ''}`} onClick={() => go(c.sections[0])}>
                <Icon size={16} />
                {c.label}
              </button>
            );
          })}
        </nav>
        <div className="smain">
          {start ? (
            <>
              <div className="shead shead-start">
                <span style={{ flex: 1 }} />
                <button className="icon-btn sm" onClick={close} title="Close (Esc)">
                  <X size={16} />
                </button>
              </div>
              <div className="sbody" ref={body}>
                <SettingsStart q={q} setQ={setQ} go={go} />
              </div>
            </>
          ) : (
            <>
              <div className="shead">
                <h2>{cat!.label}</h2>
                {cur!.fields.some((f) => f.advanced) && (
                  <label className="adv-toggle" title="Show every option">
                    <span>Advanced</span>
                    <button role="switch" aria-checked={showAdvanced} className={`switch ${showAdvanced ? 'on' : ''}`} onClick={() => useSettings.getState().set({ 'ui.showAdvanced': !showAdvanced })}>
                      <span />
                    </button>
                  </label>
                )}
                <button className="icon-btn sm" onClick={close} title="Close (Esc)">
                  <X size={16} />
                </button>
              </div>
              {cat!.sections.length > 1 && (
                <div className="stabs" role="tablist">
                  {cat!.sections.map((id) => (
                    <button key={id} role="tab" aria-selected={id === cur!.id} className={`stab ${id === cur!.id ? 'on' : ''}`} onClick={() => go(id)}>
                      {sectionById(id)?.label}
                    </button>
                  ))}
                </div>
              )}
              <div className="sbody" ref={body}>
                <SectionBody cur={cur!} showAdvanced={showAdvanced} />
              </div>
              {/* (Not on Kea account: "Reset kea account" would read like resetting the account itself.) */}
              {cur!.fields.length > 0 && cur!.id !== 'account' && (
                <div className="sfoot">
                  <button
                    className="btn sm"
                    onClick={() => {
                      useSettings.getState().set(Object.fromEntries(cur!.fields.map((f) => [f.key, f.default])));
                      toast(`${cur!.label} reset to defaults`, 'success');
                    }}
                  >
                    <RotateCcw size={13} /> Reset this page
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
