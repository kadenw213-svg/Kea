import { Logo } from '../Logo';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { BookOpen, Circle, Clapperboard, Sparkles, Cloud, FileCode2, FileText, FileType2, GraduationCap, Home, Mic, Palette, Plug, Presentation, RefreshCw, Save, Settings, Sheet, Shield, SpellCheck, Wand2 } from 'lucide-react';

// Only the icons the sections use (importing the whole icon set put ~1,500 icons into Kea's start-up code).
const Icons = { BookOpen, Circle, Clapperboard, Sparkles, Cloud, FileCode2, FileText, FileType2, GraduationCap, Home, Mic, Palette, Plug, Presentation, RefreshCw, Save, Settings, Sheet, Shield, SpellCheck, Wand2 };
import { X, Search, RotateCcw, FolderOpen, ExternalLink } from 'lucide-react';
import { SECTIONS, Field, useSettings, DEFAULTS } from '../../lib/settings';
import { api } from '../../lib/api';
import { ModelSettings } from '../lookup/ModelSettings';
import { toast, ask, useTabs } from '../../store';
import { formatBytes } from '../../lib/util';
import { SHORTCUTS } from './shortcuts';
import { GooglePanel } from './GooglePanel';
import { useUpdates } from '../Updates';
import { VoiceSettingsExtras } from '../VoiceTyping';
import { FeedbackPanel } from './FeedbackPanel';
import { ControlPanel } from '../control/ControlPanel';
import { AiModelsPanel } from './AiModelsPanel';

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

function Row({ f }: { f: Field }) {
  const value = useSettings((s) => (s.values[f.key] === undefined ? f.default : s.values[f.key]));
  const changed = JSON.stringify(value) !== JSON.stringify(DEFAULTS[f.key]);
  return (
    <div className={`srow ${f.advanced ? 'adv' : ''}`}>
      <div className="srow-text">
        <div className="srow-label">
          {f.label}
          {f.restart && <span className="sbadge">restart</span>}
          {f.advanced && <span className="sbadge adv">advanced</span>}
        </div>
        {f.help && <div className="srow-help">{f.help}</div>}
      </div>
      <div className="srow-ctl">
        {changed && (
          <button className="icon-btn sm reset" title="Reset to default" onClick={() => useSettings.getState().set({ [f.key]: f.default })}>
            <RotateCcw size={13} />
          </button>
        )}
        <FieldControl
          f={f}
          value={value}
          onChange={(v) => {
            useSettings.getState().set({ [f.key]: v });
            if (f.restart) toast('This takes effect after you restart Kea.');
          }}
        />
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
          <div className="muted">A free, offline office suite. Open source under the MIT license.</div>
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

export function SettingsDialog() {
  const { open, section } = useSettings();
  const showAdvanced = useSettings((s) => !!s.values['ui.showAdvanced']);
  const values = useSettings((s) => s.values);
  const [q, setQ] = useState('');
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        useSettings.getState().ui({ open: false });
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);
  const query = q.trim().toLowerCase();

  const visibleFields = (fields: Field[]) =>
    fields.filter((f) => (showAdvanced || !f.advanced || query) && (!f.when || f.when(values)) && (!query || (f.label + ' ' + (f.help || '')).toLowerCase().includes(query)));

  const searchHits = useMemo(() => (query ? SECTIONS.map((s) => ({ s, fields: visibleFields(s.fields) })).filter((x) => x.fields.length) : []), [query, values, showAdvanced]);

  if (!open) return null;
  const close = () => useSettings.getState().ui({ open: false });
  const cur = SECTIONS.find((s) => s.id === section) || SECTIONS[0];
  const advCount = cur.fields.filter((f) => f.advanced).length;

  const body = () => {
    if (query)
      return searchHits.length || 'shortcuts'.includes(query) ? (
        <>
          {searchHits.map(({ s, fields }) => (
            <div key={s.id} className="sgroup">
              <div className="sgroup-title">{s.label}</div>
              {fields.map((f) => (
                <Row key={f.key} f={f} />
              ))}
            </div>
          ))}
          <ShortcutsPanel q={query} />
        </>
      ) : (
        <div className="muted" style={{ padding: 24 }}>
          No settings match “{q}”.
        </div>
      );
    if (cur.id === 'shortcuts') return <ShortcutsPanel q="" />;
    if (cur.id === 'about') return <AboutPanel />;
    if (cur.id === 'feedback') return <FeedbackPanel />;
    return (
      <>
        {cur.blurb && <p className="sblurb">{cur.blurb}</p>}
        {cur.id === 'google' && <GooglePanel />}
        {cur.id === 'control' && <ControlPanel />}
        {cur.id === 'aimodels' && <AiModelsPanel />}
        {(() => {
          // Each field belongs to the group heading above it; a heading shows above the first visible field of its group.
          const groupOf = new Map<string, string>();
          let g = '';
          for (const f of cur.fields) groupOf.set(f.key, (g = f.group || g));
          let last = '';
          return visibleFields(cur.fields).map((f) => {
            const head = groupOf.get(f.key) || '';
            const show = head && head !== last;
            last = head;
            return (
              <Fragment key={f.key}>
                {show && <div className="sgroup-title sgroup-in">{head}</div>}
                <Row f={f} />
              </Fragment>
            );
          });
        })()}
        {!showAdvanced && advCount > 0 && (
          <button className="link-btn more-adv" onClick={() => useSettings.getState().set({ 'ui.showAdvanced': true })}>
            Show {advCount} advanced setting{advCount === 1 ? '' : 's'}
          </button>
        )}
        {cur.id === 'files' && <FilesExtras />}
        {cur.id === 'voice' && <VoiceSettingsExtras />}
        {cur.id === 'privacy' && <PrivacyExtras />}
        {cur.id === 'lookup' && <ModelSettings />}
      </>
    );
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog settings-dialog" role="dialog" aria-label="Settings">
        <nav className="snav">
          <div className="snav-title">Settings</div>
          <div className="search-box snav-search">
            <Search size={15} />
            <input placeholder="Search settings" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          </div>
          {SECTIONS.map((s) => {
            const Icon = (Icons as any)[s.icon] || Icons.Circle;
            return (
              <button key={s.id} className={`snav-item ${!query && s.id === cur.id ? 'on' : ''}`} onClick={() => (setQ(''), useSettings.getState().ui({ section: s.id }))}>
                <Icon size={16} />
                {s.label}
              </button>
            );
          })}
        </nav>
        <div className="smain">
          <div className="shead">
            <h2>{query ? 'Search results' : cur.label}</h2>
            <label className="adv-toggle" title="Show every option">
              <span>Advanced</span>
              <button
                role="switch"
                aria-checked={showAdvanced}
                className={`switch ${showAdvanced ? 'on' : ''}`}
                onClick={() => useSettings.getState().set({ 'ui.showAdvanced': !showAdvanced })}
              >
                <span />
              </button>
            </label>
            <button className="icon-btn sm" onClick={close} title="Close (Esc)">
              <X size={16} />
            </button>
          </div>
          <div className="sbody">{body()}</div>
          {!query && cur.fields.length > 0 && (
            <div className="sfoot">
              <button
                className="btn sm"
                onClick={() => {
                  useSettings.getState().set(Object.fromEntries(cur.fields.map((f) => [f.key, f.default])));
                  toast(`${cur.label} reset to defaults`, 'success');
                }}
              >
                <RotateCcw size={13} /> Reset {cur.label.toLowerCase()}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
