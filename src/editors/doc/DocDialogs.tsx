import { useState } from 'react';
import { X } from 'lucide-react';
import { DocMeta, PAGE_SIZES, HeaderFooter, emptyHF } from './docMeta';
import { useSettings } from '../../lib/settings';
import { toast } from '../../store';

const FONTS = ['Arial', 'Calibri', 'Cambria', 'Georgia', 'Garamond', 'Segoe UI', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Courier New'];
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

function Num({ value, onChange, step = 0.1, min = 0, max = 30, unit }: { value: number; onChange(v: number): void; step?: number; min?: number; max?: number; unit?: string }) {
  return (
    <span className="num-field">
      <input className="input sm" type="number" value={value} step={step} min={min} max={max} onChange={(e) => e.target.value !== '' && onChange(Math.min(max, Math.max(min, Number(e.target.value))))} />
      {unit && <span className="muted">{unit}</span>}
    </span>
  );
}

/** Page size, orientation, margins and the document's default text formatting (Word's "Normal" style). */
export function PageSetupDialog({ meta, onClose, onApply }: { meta: DocMeta; onClose(): void; onApply(m: DocMeta): void }) {
  const [m, setM] = useState(() => clone(meta));
  const [adv, setAdv] = useState(false);
  const set = (fn: (d: DocMeta) => void) => setM((cur) => {
    const next = clone(cur);
    fn(next);
    return next;
  });
  const mg = m.page.margins;
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog doc-dialog">
        <div className="ai-settings-head">
          <h2>Page setup</h2>
          <button className="icon-btn sm" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="dd-grid">
          <label>Paper size</label>
          <select
            className="select"
            value={m.page.size}
            onChange={(e) =>
              set((d) => {
                d.page.size = e.target.value as any;
                const p = PAGE_SIZES[e.target.value];
                if (p) {
                  d.page.width = p.w;
                  d.page.height = p.h;
                }
              })
            }
          >
            {Object.entries(PAGE_SIZES).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
            <option value="custom">Custom…</option>
          </select>
          {m.page.size === 'custom' && (
            <>
              <label>Width × height</label>
              <span className="dd-row">
                <Num value={m.page.width} onChange={(v) => set((d) => (d.page.width = v))} min={2} max={30} unit="in" />
                <Num value={m.page.height} onChange={(v) => set((d) => (d.page.height = v))} min={2} max={30} unit="in" />
              </span>
            </>
          )}
          <label>Orientation</label>
          <span className="seg">
            <button className={!m.page.landscape ? 'on' : ''} onClick={() => set((d) => (d.page.landscape = false))}>
              Portrait
            </button>
            <button className={m.page.landscape ? 'on' : ''} onClick={() => set((d) => (d.page.landscape = true))}>
              Landscape
            </button>
          </span>
          <label>Margins</label>
          <span className="dd-margins">
            <span>
              Top <Num value={mg.top} onChange={(v) => set((d) => (d.page.margins.top = v))} max={5} unit="in" />
            </span>
            <span>
              Bottom <Num value={mg.bottom} onChange={(v) => set((d) => (d.page.margins.bottom = v))} max={5} unit="in" />
            </span>
            <span>
              Left <Num value={mg.left} onChange={(v) => set((d) => (d.page.margins.left = v))} max={5} unit="in" />
            </span>
            <span>
              Right <Num value={mg.right} onChange={(v) => set((d) => (d.page.margins.right = v))} max={5} unit="in" />
            </span>
          </span>
          <label>Layout</label>
          <span className="seg">
            <button className={!m.pageless ? 'on' : ''} onClick={() => set((d) => (d.pageless = false))}>
              Pages
            </button>
            <button className={m.pageless ? 'on' : ''} onClick={() => set((d) => (d.pageless = true))}>
              Pageless
            </button>
          </span>
        </div>

        <div className="dd-section">Default text</div>
        <div className="dd-grid">
          <label>Font</label>
          <span className="dd-row">
            <select className="select" value={FONTS.includes(m.defaults.font) ? m.defaults.font : '__o'} onChange={(e) => set((d) => (d.defaults.font = e.target.value))} style={{ fontFamily: m.defaults.font }}>
              {!FONTS.includes(m.defaults.font) && <option value="__o">{m.defaults.font}</option>}
              {FONTS.map((f) => (
                <option key={f} value={f} style={{ fontFamily: f }}>
                  {f}
                </option>
              ))}
            </select>
            <Num value={m.defaults.sizePt} onChange={(v) => set((d) => (d.defaults.sizePt = v))} step={0.5} min={4} max={96} unit="pt" />
          </span>
          <label>Line spacing</label>
          <select className="select" value={String(m.defaults.lineHeight)} onChange={(e) => set((d) => (d.defaults.lineHeight = Number(e.target.value)))}>
            {[1, 1.15, 1.5, 2, 2.5, 3].map((v) => (
              <option key={v} value={String(v)}>
                {v === 1 ? 'Single' : v === 2 ? 'Double' : v}
              </option>
            ))}
            {![1, 1.15, 1.5, 2, 2.5, 3].includes(m.defaults.lineHeight) && <option value={String(m.defaults.lineHeight)}>{m.defaults.lineHeight}</option>}
          </select>
          <label>Space after paragraphs</label>
          <Num value={m.defaults.spaceAfterPt} onChange={(v) => set((d) => (d.defaults.spaceAfterPt = v))} step={1} max={72} unit="pt" />
          <label>Indent first line</label>
          <Num value={m.defaults.firstLineIn} onChange={(v) => set((d) => (d.defaults.firstLineIn = v))} step={0.25} max={3} unit="in" />
        </div>

        <button className="link-btn" style={{ marginTop: 10 }} onClick={() => setAdv((a) => !a)}>
          {adv ? 'Hide' : 'Show'} advanced
        </button>
        {adv && (
          <div className="dd-grid" style={{ marginTop: 8 }}>
            <label>Header from top</label>
            <Num value={m.page.headerDistance} onChange={(v) => set((d) => (d.page.headerDistance = v))} max={3} unit="in" />
            <label>Footer from bottom</label>
            <Num value={m.page.footerDistance} onChange={(v) => set((d) => (d.page.footerDistance = v))} max={3} unit="in" />
            <label>First page number</label>
            <Num value={m.pageNumberStart} onChange={(v) => set((d) => (d.pageNumberStart = Math.round(v)))} step={1} min={0} max={9999} />
          </div>
        )}

        <div className="dialog-actions">
          <button
            className="btn"
            onClick={() => {
              useSettings.getState().set({
                'doc.font': m.defaults.font,
                'doc.size': m.defaults.sizePt,
                'doc.lineHeight': m.defaults.lineHeight,
                'doc.spaceAfter': m.defaults.spaceAfterPt,
                'doc.firstLine': m.defaults.firstLineIn,
                'doc.pageSize': m.page.size === 'custom' ? 'letter' : m.page.size,
                'doc.margin': m.page.margins.top,
                'doc.pageless': !!m.pageless
              });
              toast('New documents will use these settings', 'success');
            }}
          >
            Set as default
          </button>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => (onApply(m), onClose())}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

const FIELDS = [
  ['{PAGE}', 'Page number'],
  ['{PAGES}', 'Number of pages'],
  ['{TITLE}', 'File name'],
  ['{DATE}', 'Date']
];

function HFEditor({ label, hf, onChange }: { label: string; hf: HeaderFooter; onChange(hf: HeaderFooter): void }) {
  const [focus, setFocus] = useState<keyof HeaderFooter>('right');
  return (
    <div className="hf-edit">
      <div className="hf-edit-label">{label}</div>
      <div className="hf-slots">
        {(['left', 'center', 'right'] as const).map((k) => (
          <input
            key={k}
            className="input sm"
            style={{ textAlign: k }}
            placeholder={k === 'left' ? 'Left' : k === 'center' ? 'Center' : 'Right'}
            value={hf[k]}
            onFocus={() => setFocus(k)}
            onChange={(e) => onChange({ ...hf, [k]: e.target.value })}
          />
        ))}
      </div>
      <div className="hf-fields">
        {FIELDS.map(([f, l]) => (
          <button key={f} className="chip-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => onChange({ ...hf, [focus]: (hf[focus] ? hf[focus] + ' ' : '') + f })}>
            + {l}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Headers, footers and page numbers. */
export function HeaderFooterDialog({ meta, onClose, onApply, author }: { meta: DocMeta; onClose(): void; onApply(m: DocMeta): void; author?: string }) {
  const [m, setM] = useState(() => clone(meta));
  const diff = !!(m.firstHeader || m.firstFooter);
  const last = (author || '').trim().split(/\s+/).pop() || 'Lastname';
  const preset = (fn: (d: DocMeta) => void) =>
    setM((cur) => {
      const d = clone(cur);
      fn(d);
      return d;
    });
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog doc-dialog">
        <div className="ai-settings-head">
          <h2>Header, footer &amp; page numbers</h2>
          <button className="icon-btn sm" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="hf-presets">
          <span className="muted">Quick:</span>
          <button className="chip-btn" onClick={() => preset((d) => (d.header = { left: '', center: '', right: `${last} {PAGE}` }))}>
            MLA ({last} 1)
          </button>
          <button className="chip-btn" onClick={() => preset((d) => (d.header = { left: '', center: '', right: '{PAGE}' }))}>
            APA (page top right)
          </button>
          <button className="chip-btn" onClick={() => preset((d) => (d.footer = { left: '', center: '{PAGE}', right: '' }))}>
            Page number at bottom
          </button>
          <button className="chip-btn" onClick={() => preset((d) => (d.footer = { left: '', center: 'Page {PAGE} of {PAGES}', right: '' }))}>
            Page X of Y
          </button>
          <button className="chip-btn" onClick={() => preset((d) => ((d.header = emptyHF()), (d.footer = emptyHF()), (d.firstHeader = null), (d.firstFooter = null)))}>
            Remove all
          </button>
        </div>
        <HFEditor label="Header" hf={m.header} onChange={(hf) => setM({ ...m, header: hf })} />
        <HFEditor label="Footer" hf={m.footer} onChange={(hf) => setM({ ...m, footer: hf })} />
        <label className="hf-check">
          <input type="checkbox" checked={diff} onChange={(e) => setM({ ...m, firstHeader: e.target.checked ? emptyHF() : null, firstFooter: e.target.checked ? emptyHF() : null })} />
          Different first page (e.g. a title page with no number)
        </label>
        {diff && (
          <>
            <HFEditor label="First page header" hf={m.firstHeader || emptyHF()} onChange={(hf) => setM({ ...m, firstHeader: hf })} />
            <HFEditor label="First page footer" hf={m.firstFooter || emptyHF()} onChange={(hf) => setM({ ...m, firstFooter: hf })} />
          </>
        )}
        <div className="dd-grid" style={{ marginTop: 10 }}>
          <label>Start numbering at</label>
          <Num value={m.pageNumberStart} onChange={(v) => setM({ ...m, pageNumberStart: Math.round(v) })} step={1} min={0} max={9999} />
        </div>
        <div className="dialog-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => (onApply(m), onClose())}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
