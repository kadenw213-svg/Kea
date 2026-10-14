import { useMemo, useState } from 'react';
import { X, Plus, Trash2, BarChart3, BarChartHorizontal, LineChart, AreaChart, PieChart, Donut, ScatterChart, Search } from 'lucide-react';
import type { Chart, ChartType, CondRule, CondType, Validation, Range, Sheet, Workbook, FilterState } from './model';
import { Calc } from './model';
import { chartData, chartSvg } from './chart';
import { columnValues } from './features';
import { addr, parseAddr } from './formula';
import { uid } from '../../lib/util';

export const rangeText = (g: Range) => (g.r1 === g.r2 && g.c1 === g.c2 ? addr(g.r1, g.c1) : `${addr(g.r1, g.c1)}:${addr(g.r2, g.c2)}`);
export function parseRange(s: string): Range | null {
  const [a, b] = s.replace(/\$/g, '').trim().toUpperCase().split(':').map(parseAddr);
  if (!a) return null;
  const e = b || a;
  return { r1: Math.min(a.r, e.r), c1: Math.min(a.c, e.c), r2: Math.max(a.r, e.r), c2: Math.max(a.c, e.c) };
}

const TYPES: { type: ChartType; label: string; Icon: any }[] = [
  { type: 'column', label: 'Column', Icon: BarChart3 },
  { type: 'bar', label: 'Bar', Icon: BarChartHorizontal },
  { type: 'line', label: 'Line', Icon: LineChart },
  { type: 'area', label: 'Area', Icon: AreaChart },
  { type: 'pie', label: 'Pie', Icon: PieChart },
  { type: 'doughnut', label: 'Doughnut', Icon: Donut },
  { type: 'scatter', label: 'Scatter', Icon: ScatterChart }
];

/** Create or edit a chart, with a live preview. */
export function ChartDialog({ chart, sheet, calc, onSave, onDelete, onClose }: { chart: Chart; sheet: Sheet; calc: Calc; onSave(c: Chart): void; onDelete?: () => void; onClose(): void }) {
  const [c, setC] = useState<Chart>(chart);
  const [rangeStr, setRangeStr] = useState(rangeText(chart.range));
  const [adv, setAdv] = useState(false);
  const preview = useMemo(() => chartSvg(c, chartData(c, sheet, calc), 440, 270, 'dark'), [c, sheet, calc]);
  const up = (patch: Partial<Chart>) => setC({ ...c, ...patch });
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog chart-dialog">
        <div className="ai-settings-head">
          <h2>{onDelete ? 'Edit chart' : 'Insert chart'}</h2>
          <button className="icon-btn sm" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="chart-dlg-body">
          <div className="chart-preview" dangerouslySetInnerHTML={{ __html: preview }} />
          <div className="chart-form">
            <div className="chart-types">
              {TYPES.map(({ type, label, Icon }) => (
                <button key={type} className={`chart-type ${c.type === type ? 'on' : ''}`} onClick={() => up({ type })} title={label}>
                  <Icon size={20} />
                  <span>{label}</span>
                </button>
              ))}
            </div>
            <label className="cf">
              <span>Data range</span>
              <input
                className="input sm"
                value={rangeStr}
                onChange={(e) => {
                  setRangeStr(e.target.value);
                  const g = parseRange(e.target.value);
                  if (g) up({ range: g });
                }}
              />
            </label>
            <label className="cf">
              <span>Title</span>
              <input className="input sm" value={c.title || ''} placeholder="Chart title" onChange={(e) => up({ title: e.target.value })} />
            </label>
            <label className="cf">
              <span>Legend</span>
              <select className="select" value={c.legend || 'auto'} onChange={(e) => up({ legend: e.target.value === 'auto' ? undefined : (e.target.value as any) })}>
                <option value="auto">Automatic</option>
                <option value="bottom">Bottom</option>
                <option value="top">Top</option>
                <option value="right">Right</option>
                <option value="none">None</option>
              </select>
            </label>
            {(c.type === 'column' || c.type === 'bar' || c.type === 'area') && (
              <label className="hf-check">
                <input type="checkbox" checked={!!c.stacked} onChange={(e) => up({ stacked: e.target.checked })} /> Stacked
              </label>
            )}
            {(c.type === 'line' || c.type === 'area') && (
              <label className="hf-check">
                <input type="checkbox" checked={!!c.smooth} onChange={(e) => up({ smooth: e.target.checked })} /> Smooth lines
              </label>
            )}
            <label className="hf-check">
              <input type="checkbox" checked={!!c.showValues} onChange={(e) => up({ showValues: e.target.checked })} /> Show values
            </label>
            <button className="link-btn" onClick={() => setAdv((a) => !a)}>
              {adv ? 'Hide' : 'Show'} advanced
            </button>
            {adv && (
              <>
                <label className="cf">
                  <span>Series from</span>
                  <select className="select" value={c.seriesBy || 'cols'} onChange={(e) => up({ seriesBy: e.target.value as any })}>
                    <option value="cols">Columns</option>
                    <option value="rows">Rows</option>
                  </select>
                </label>
                <label className="hf-check">
                  <input type="checkbox" checked={c.headerRow !== false} onChange={(e) => up({ headerRow: e.target.checked })} /> First row is series names
                </label>
                <label className="hf-check">
                  <input type="checkbox" checked={c.labelCol !== false} onChange={(e) => up({ labelCol: e.target.checked })} /> First column is labels
                </label>
                {c.type !== 'pie' && c.type !== 'doughnut' && (
                  <>
                    <label className="cf">
                      <span>Horizontal axis title</span>
                      <input className="input sm" value={c.xTitle || ''} onChange={(e) => up({ xTitle: e.target.value })} />
                    </label>
                    <label className="cf">
                      <span>Vertical axis title</span>
                      <input className="input sm" value={c.yTitle || ''} onChange={(e) => up({ yTitle: e.target.value })} />
                    </label>
                  </>
                )}
              </>
            )}
          </div>
        </div>
        <div className="dialog-actions">
          {onDelete && (
            <button className="btn danger" onClick={onDelete}>
              <Trash2 size={14} /> Delete chart
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => onSave(c)}>
            {onDelete ? 'Done' : 'Insert'}
          </button>
        </div>
      </div>
    </div>
  );
}

const COND_TYPES: { value: CondType; label: string; needs?: 'a' | 'ab' | 'n' }[] = [
  { value: 'gt', label: 'Greater than', needs: 'a' },
  { value: 'lt', label: 'Less than', needs: 'a' },
  { value: 'gte', label: 'Greater than or equal to', needs: 'a' },
  { value: 'lte', label: 'Less than or equal to', needs: 'a' },
  { value: 'between', label: 'Between', needs: 'ab' },
  { value: 'eq', label: 'Equal to', needs: 'a' },
  { value: 'neq', label: 'Not equal to', needs: 'a' },
  { value: 'contains', label: 'Text contains', needs: 'a' },
  { value: 'notContains', label: "Text doesn't contain", needs: 'a' },
  { value: 'startsWith', label: 'Text starts with', needs: 'a' },
  { value: 'empty', label: 'Is empty' },
  { value: 'notEmpty', label: 'Is not empty' },
  { value: 'dup', label: 'Duplicate values' },
  { value: 'unique', label: 'Unique values' },
  { value: 'top', label: 'Top N', needs: 'n' },
  { value: 'bottom', label: 'Bottom N', needs: 'n' },
  { value: 'aboveAvg', label: 'Above average' },
  { value: 'belowAvg', label: 'Below average' },
  { value: 'formula', label: 'Custom formula', needs: 'a' },
  { value: 'scale', label: 'Colour scale' },
  { value: 'bars', label: 'Data bars' }
];
const STYLES = [
  { label: 'Red', style: { bg: '#f4c7c3', color: '#8a1c13' } },
  { label: 'Green', style: { bg: '#b7e1cd', color: '#0d652d' } },
  { label: 'Yellow', style: { bg: '#fce8b2', color: '#7a5600' } },
  { label: 'Blue', style: { bg: '#c6dafc', color: '#174ea6' } },
  { label: 'Bold red text', style: { color: '#d93025', b: true } },
  { label: 'Strikethrough', style: { color: '#80868b', s: true } }
];
const SCALES = [
  ['#f8696b', '#ffeb84', '#63be7b'],
  ['#63be7b', '#ffeb84', '#f8696b'],
  ['#ffffff', '#63be7b'],
  ['#ffffff', '#5a8ac6'],
  ['#ffffff', '#f8696b']
];

/** Manage conditional formatting rules for the sheet. */
export function CondFormatDialog({ rules, selection, onSave, onClose }: { rules: CondRule[]; selection: Range; onSave(r: CondRule[]): void; onClose(): void }) {
  const [list, setList] = useState<CondRule[]>(rules);
  const [edit, setEdit] = useState<CondRule | null>(rules.length ? null : { id: uid(), range: selection, type: 'gt', a: '', style: STYLES[0].style });
  const [rangeStr, setRangeStr] = useState(rangeText(edit?.range || selection));
  const meta = COND_TYPES.find((t) => t.value === edit?.type);
  const describe = (r: CondRule) => {
    const t = COND_TYPES.find((x) => x.value === r.type)?.label || r.type;
    return `${rangeText(r.range)} · ${t}${r.a ? ` ${r.a}` : ''}${r.b ? ` and ${r.b}` : ''}${r.n ? ` ${r.n}` : ''}`;
  };
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog doc-dialog">
        <div className="ai-settings-head">
          <h2>Conditional formatting</h2>
          <button className="icon-btn sm" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        {!edit ? (
          <>
            <div className="cfr-list">
              {list.map((r) => (
                <div key={r.id} className="cfr" onClick={() => (setEdit(r), setRangeStr(rangeText(r.range)))}>
                  <span className="cfr-swatch" style={{ background: r.type === 'scale' ? `linear-gradient(90deg, ${(r.colors || SCALES[0]).join(',')})` : r.type === 'bars' ? r.colors?.[0] || '#638ec6' : r.style?.bg || 'transparent', color: r.style?.color }}>
                    {r.type === 'scale' || r.type === 'bars' ? '' : 'Aa'}
                  </span>
                  <span className="cfr-desc">{describe(r)}</span>
                  <button
                    className="icon-btn sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      setList(list.filter((x) => x.id !== r.id));
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              {!list.length && <div className="muted">No rules yet.</div>}
            </div>
            <button
              className="btn sm"
              style={{ marginTop: 10 }}
              onClick={() => {
                setEdit({ id: uid(), range: selection, type: 'gt', a: '', style: STYLES[0].style });
                setRangeStr(rangeText(selection));
              }}
            >
              <Plus size={14} /> Add rule
            </button>
            <div className="dialog-actions">
              <button className="btn" onClick={onClose}>
                Cancel
              </button>
              <button className="btn primary" onClick={() => (onSave(list), onClose())}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="dd-grid">
              <label>Apply to</label>
              <input
                className="input sm"
                value={rangeStr}
                onChange={(e) => {
                  setRangeStr(e.target.value);
                  const g = parseRange(e.target.value);
                  if (g) setEdit({ ...edit, range: g });
                }}
              />
              <label>Format cells if</label>
              <select className="select" value={edit.type} onChange={(e) => setEdit({ ...edit, type: e.target.value as CondType, colors: e.target.value === 'scale' ? SCALES[0] : e.target.value === 'bars' ? ['#638ec6'] : edit.colors })}>
                {COND_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
              {meta?.needs === 'a' || meta?.needs === 'ab' ? (
                <>
                  <label>{edit.type === 'formula' ? 'Formula (for the first cell)' : 'Value'}</label>
                  <span className="dd-row">
                    <input className="input sm" value={edit.a || ''} placeholder={edit.type === 'formula' ? '=B2>100' : ''} onChange={(e) => setEdit({ ...edit, a: e.target.value.replace(/^=/, '') })} />
                    {meta.needs === 'ab' && (
                      <>
                        and <input className="input sm" value={edit.b || ''} onChange={(e) => setEdit({ ...edit, b: e.target.value })} />
                      </>
                    )}
                  </span>
                </>
              ) : meta?.needs === 'n' ? (
                <>
                  <label>How many</label>
                  <input className="input sm" type="number" value={edit.n || 10} onChange={(e) => setEdit({ ...edit, n: Number(e.target.value) || 10 })} />
                </>
              ) : null}
              {edit.type === 'scale' ? (
                <>
                  <label>Colours</label>
                  <span className="dd-row" style={{ flexWrap: 'wrap' }}>
                    {SCALES.map((s, i) => (
                      <button key={i} className={`scale-btn ${JSON.stringify(edit.colors) === JSON.stringify(s) ? 'on' : ''}`} style={{ background: `linear-gradient(90deg, ${s.join(',')})` }} onClick={() => setEdit({ ...edit, colors: s })} />
                    ))}
                  </span>
                </>
              ) : edit.type === 'bars' ? (
                <>
                  <label>Bar colour</label>
                  <input type="color" className="color-field" value={edit.colors?.[0] || '#638ec6'} onChange={(e) => setEdit({ ...edit, colors: [e.target.value] })} />
                </>
              ) : (
                <>
                  <label>Formatting</label>
                  <span className="dd-row" style={{ flexWrap: 'wrap' }}>
                    {STYLES.map((s) => (
                      <button
                        key={s.label}
                        className={`style-btn ${JSON.stringify(edit.style) === JSON.stringify(s.style) ? 'on' : ''}`}
                        style={{ background: s.style.bg, color: s.style.color, fontWeight: s.style.b ? 700 : undefined, textDecoration: s.style.s ? 'line-through' : undefined }}
                        onClick={() => setEdit({ ...edit, style: s.style })}
                      >
                        {s.label}
                      </button>
                    ))}
                    <input type="color" className="color-field" title="Custom fill" value={edit.style?.bg || '#ffffff'} onChange={(e) => setEdit({ ...edit, style: { ...edit.style, bg: e.target.value } })} />
                  </span>
                </>
              )}
            </div>
            <div className="dialog-actions">
              <button className="btn" onClick={() => (list.length ? setEdit(null) : onClose())}>
                Back
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  const next = list.some((x) => x.id === edit.id) ? list.map((x) => (x.id === edit.id ? edit : x)) : [...list, edit];
                  setList(next);
                  setEdit(null);
                }}
              >
                Save rule
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Dropdown lists, checkboxes and limits for a range of cells. */
export function ValidationDialog({ existing, selection, onSave, onRemove, onClose }: { existing?: Validation; selection: Range; onSave(v: Validation): void; onRemove?: () => void; onClose(): void }) {
  const [v, setV] = useState<Validation>(existing || { id: uid(), range: selection, type: 'list', values: [], strict: true });
  const [items, setItems] = useState((existing?.values || []).join('\n'));
  const [rangeStr, setRangeStr] = useState(rangeText(v.range));
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog doc-dialog">
        <div className="ai-settings-head">
          <h2>Data validation</h2>
          <button className="icon-btn sm" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="dd-grid">
          <label>Cells</label>
          <input
            className="input sm"
            value={rangeStr}
            onChange={(e) => {
              setRangeStr(e.target.value);
              const g = parseRange(e.target.value);
              if (g) setV({ ...v, range: g });
            }}
          />
          <label>Allow</label>
          <select className="select" value={v.type} onChange={(e) => setV({ ...v, type: e.target.value as Validation['type'] })}>
            <option value="list">Dropdown list</option>
            <option value="checkbox">Checkbox</option>
            <option value="number">Number</option>
            <option value="date">Date</option>
            <option value="textLength">Text length</option>
          </select>
          {v.type === 'list' && (
            <>
              <label>Items (one per line)</label>
              <textarea className="rv-input" style={{ minHeight: 100, marginTop: 0 }} value={items} onChange={(e) => setItems(e.target.value)} placeholder={'Yes\nNo\nMaybe'} />
              <label>…or from cells</label>
              <input className="input sm" value={v.source || ''} placeholder="e.g. Sheet2!A1:A10" onChange={(e) => setV({ ...v, source: e.target.value })} />
            </>
          )}
          {(v.type === 'number' || v.type === 'textLength') && (
            <>
              <label>Between</label>
              <span className="dd-row">
                <input className="input sm" type="number" value={v.min ?? ''} placeholder="min" onChange={(e) => setV({ ...v, min: e.target.value === '' ? null : Number(e.target.value) })} />
                and
                <input className="input sm" type="number" value={v.max ?? ''} placeholder="max" onChange={(e) => setV({ ...v, max: e.target.value === '' ? null : Number(e.target.value) })} />
              </span>
            </>
          )}
          <label>If the data is invalid</label>
          <select className="select" value={v.strict ? 'reject' : 'warn'} onChange={(e) => setV({ ...v, strict: e.target.value === 'reject' })}>
            <option value="reject">Reject it</option>
            <option value="warn">Show a warning</option>
          </select>
          <label>Help text</label>
          <input className="input sm" value={v.help || ''} placeholder="Optional, shown when the cell is selected" onChange={(e) => setV({ ...v, help: e.target.value })} />
        </div>
        <div className="dialog-actions">
          {onRemove && (
            <button className="btn danger" onClick={() => (onRemove(), onClose())}>
              Remove rule
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={() => {
              onSave({ ...v, values: v.type === 'list' ? items.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : undefined });
              onClose();
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

/** The menu behind a filter button: sort, pick values, or a condition. */
export function FilterMenu({ sheet, calc, filter, col, onApply, onSort, onClose }: { sheet: Sheet; calc: Calc; filter: FilterState; col: number; onApply(crit: FilterState['cols'][number] | null): void; onSort(desc: boolean): void; onClose(): void }) {
  const values = useMemo(() => columnValues(sheet, calc, filter, col), [sheet, calc, filter, col]);
  const cur = filter.cols[col];
  const [hidden, setHidden] = useState<Set<string>>(new Set(cur?.hide || []));
  const [q, setQ] = useState('');
  const [condType, setCondType] = useState<CondType | ''>(cur?.cond?.type || '');
  const [a, setA] = useState(cur?.cond?.a || '');
  const [b, setB] = useState(cur?.cond?.b || '');
  const shown = values.filter(([v]) => !q || v.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="filter-menu" onMouseDown={(e) => e.stopPropagation()}>
      <button className="menu-item" onClick={() => (onSort(false), onClose())}>
        Sort A → Z
      </button>
      <button className="menu-item" onClick={() => (onSort(true), onClose())}>
        Sort Z → A
      </button>
      <div className="menu-sep" />
      <div className="fm-title">Filter by condition</div>
      <select className="select" value={condType} onChange={(e) => setCondType(e.target.value as CondType | '')}>
        <option value="">None</option>
        {COND_TYPES.filter((t) => !['dup', 'unique', 'top', 'bottom', 'aboveAvg', 'belowAvg', 'scale', 'bars', 'formula'].includes(t.value)).map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </select>
      {condType && COND_TYPES.find((t) => t.value === condType)?.needs && (
        <div className="dd-row" style={{ marginTop: 6 }}>
          <input className="input sm" value={a} onChange={(e) => setA(e.target.value)} placeholder="Value" />
          {condType === 'between' && <input className="input sm" value={b} onChange={(e) => setB(e.target.value)} placeholder="and" />}
        </div>
      )}
      <div className="fm-title">Filter by values</div>
      <div className="search-box" style={{ width: 'auto', height: 32, marginBottom: 6 }}>
        <Search size={14} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" />
      </div>
      <div className="fm-actions">
        <button className="link-btn" onClick={() => setHidden(new Set())}>
          Select all
        </button>
        <button className="link-btn" onClick={() => setHidden(new Set(values.map(([v]) => v)))}>
          Clear
        </button>
      </div>
      <div className="fm-values">
        {shown.slice(0, 500).map(([v, n]) => (
          <label key={v} className="fm-value">
            <input
              type="checkbox"
              checked={!hidden.has(v)}
              onChange={(e) => {
                const next = new Set(hidden);
                if (e.target.checked) next.delete(v);
                else next.add(v);
                setHidden(next);
              }}
            />
            <span>{v === '' ? '(Blanks)' : v}</span>
            <span className="muted">{n}</span>
          </label>
        ))}
      </div>
      <div className="fm-foot">
        <button className="btn sm" onClick={() => (onApply(null), onClose())}>
          Clear filter
        </button>
        <button
          className="btn sm primary"
          onClick={() => {
            const crit = { hide: hidden.size ? [...hidden] : undefined, cond: condType ? { type: condType, a, b } : undefined };
            onApply(crit.hide || crit.cond ? crit : null);
            onClose();
          }}
        >
          OK
        </button>
      </div>
    </div>
  );
}

export type { Workbook };

/** Summarize a table: group by one column and total another (a simple pivot table), on a new sheet. */
export function PivotDialog({ headers, onCreate, onClose }: { headers: string[]; onCreate(opts: { group: number; group2: number | null; value: number | null; agg: 'sum' | 'count' | 'average' | 'min' | 'max' }): void; onClose(): void }) {
  const [group, setGroup] = useState(0);
  const [group2, setGroup2] = useState<number | null>(null);
  const [value, setValue] = useState<number | null>(headers.length > 1 ? 1 : null);
  const [agg, setAgg] = useState<'sum' | 'count' | 'average' | 'min' | 'max'>('sum');
  const opts = headers.map((h, i) => (
    <option key={i} value={i}>
      {h || `Column ${i + 1}`}
    </option>
  ));
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog doc-dialog">
        <div className="ai-settings-head">
          <h2>Summarize data</h2>
          <button className="icon-btn sm" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <p className="muted" style={{ fontSize: 13 }}>
          Builds a summary table (like a pivot table) on a new sheet.
        </p>
        <div className="dd-grid">
          <label>Rows: group by</label>
          <select className="select" value={group} onChange={(e) => setGroup(Number(e.target.value))}>
            {opts}
          </select>
          <label>Columns: group by</label>
          <select className="select" value={group2 ?? ''} onChange={(e) => setGroup2(e.target.value === '' ? null : Number(e.target.value))}>
            <option value="">(none)</option>
            {opts}
          </select>
          <label>Values</label>
          <span className="dd-row">
            <select className="select" value={agg} onChange={(e) => setAgg(e.target.value as any)}>
              <option value="sum">Sum of</option>
              <option value="average">Average of</option>
              <option value="count">Count of</option>
              <option value="min">Min of</option>
              <option value="max">Max of</option>
            </select>
            <select className="select" value={value ?? ''} onChange={(e) => setValue(e.target.value === '' ? null : Number(e.target.value))}>
              <option value="">(rows)</option>
              {opts}
            </select>
          </span>
        </div>
        <div className="dialog-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => (onCreate({ group, group2, value, agg }), onClose())}>
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
