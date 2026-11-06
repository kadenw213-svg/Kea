import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { texToSvg, MATH_SNIPPETS } from './math';

/** Write or edit an equation with a live preview. */
export function MathDialog({ initial, display: initialDisplay, onSave, onRemove, onClose }: { initial: string; display: boolean; onSave(latex: string, display: boolean): void; onRemove?: () => void; onClose(): void }) {
  const [tex, setTex] = useState(initial);
  const [display, setDisplay] = useState(initialDisplay);
  const [svg, setSvg] = useState('');
  const ta = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => texToSvg(tex, display).then((s) => alive && setSvg(s)), 120);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [tex, display]);

  const insert = (snippet: string) => {
    const el = ta.current;
    if (!el) return setTex(tex + snippet);
    const s = el.selectionStart;
    const e = el.selectionEnd;
    const next = tex.slice(0, s) + snippet + tex.slice(e);
    setTex(next);
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = s + snippet.length;
    });
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog math-dialog">
        <div className="ai-settings-head">
          <h2>{initial ? 'Edit equation' : 'Insert equation'}</h2>
          <button className="icon-btn sm" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="math-preview" dangerouslySetInnerHTML={{ __html: svg || '&nbsp;' }} />
        <textarea
          ref={ta}
          className="math-input"
          autoFocus
          spellCheck={false}
          placeholder="Type LaTeX, e.g. x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}"
          value={tex}
          onChange={(e) => setTex(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              onSave(tex.trim(), display);
            }
          }}
        />
        {MATH_SNIPPETS.map((g) => (
          <div key={g.group} className="math-group">
            <span className="muted">{g.group}</span>
            <div className="math-btns">
              {g.items.map(([label, snip]) => (
                <button key={label + snip} className="chip-btn" title={snip} onClick={() => insert(snip)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        ))}
        <label className="hf-check" style={{ marginTop: 10 }}>
          <input type="checkbox" checked={display} onChange={(e) => setDisplay(e.target.checked)} />
          Display style (larger, for an equation on its own line)
        </label>
        <div className="dialog-actions">
          {onRemove && (
            <button className="btn danger" onClick={onRemove}>
              Remove
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!tex.trim()} onClick={() => onSave(tex.trim(), display)}>
            {initial ? 'Update' : 'Insert'}
          </button>
        </div>
      </div>
    </div>
  );
}
