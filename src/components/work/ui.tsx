// Small pieces shared by the Work screens.
import { createContext, ReactNode, useContext } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { FoldAlert, useFold, useFoldPlace } from '../Fold';
import type { Stage } from './types';

export function Loading() {
  return (
    <div className="wk-loading">
      <div className="spinner" />
    </div>
  );
}
export function Problem({ error, retry }: { error: string | null; retry?: () => void }) {
  if (!error) return null;
  return (
    <div className="wk-problem">
      <span>{error}</span>
      {retry && (
        <button className="btn sm" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="wk-empty">
      <h3>{title}</h3>
      {children}
    </div>
  );
}
/** The card an Advanced section is in (each remembers being opened on its own). */
const CardCtx = createContext<{ screen: string; id: string } | null>(null);
/**
 * A card. On a Work tab (inside its FoldGroup) a card with a title folds like every section in Kea: the first one
 * showing starts open, the rest closed, and each remembers being opened or closed. `fold`: its name when the title
 * isn't plain text, or false for a card that must stay open (an answer just asked for). `alert`: what's waiting or
 * overdue in it, kept on its header while it's closed.
 */
export function Card({ title, actions, children, className = '', fold, alert }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; fold?: string | false; alert?: number | boolean | null }) {
  // (A count in the title, "People (12)", isn't part of its name.)
  const id = fold === false ? '' : fold || (typeof title === 'string' ? title.replace(/\s*\([^)]*\)\s*$/, '') : '');
  const place = useFoldPlace(id || '-');
  const foldable = !!id && !!place.group;
  const screen = place.group?.screen || 'work';
  const [open, setOpen] = useFold(screen, id, place.first ?? true);
  const shown = !foldable || open;
  return (
    <section ref={foldable ? place.ref : undefined} className={`wk-card ${foldable && !open ? 'folded' : ''} ${className}`}>
      {(title || actions) && (
        <header className="wk-card-head">
          {title &&
            (foldable ? (
              <button className="wk-card-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
                {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                <h3>{title}</h3>
                <FoldAlert open={open} alert={alert} />
              </button>
            ) : (
              <h3>{title}</h3>
            ))}
          {actions && shown && <div className="wk-card-actions">{actions}</div>}
        </header>
      )}
      {shown && <CardCtx.Provider value={id ? { screen, id } : null}>{children}</CardCtx.Provider>}
    </section>
  );
}
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="wk-field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="wk-hint">{hint}</span>}
    </label>
  );
}
export function Check({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange(v: boolean): void; hint?: string }) {
  return (
    <label className="wk-check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && <span className="wk-hint"> {hint}</span>}
      </span>
    </label>
  );
}
/** The Advanced section every feature has: closed by default, every option inside; it remembers being opened. */
export function Advanced({ children, label = 'Advanced' }: { children: ReactNode; label?: string }) {
  const card = useContext(CardCtx);
  const [open, setOpen] = useFold(card?.screen || 'work', `${card?.id || ''}/${label}`, false);
  return (
    <div className={`wk-advanced ${open ? 'open' : ''}`}>
      <button className="btn link sm wk-adv-toggle" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {label}
      </button>
      {open && <div className="wk-adv-body">{children}</div>}
    </div>
  );
}
const STAGE_TEXT: Record<string, string> = { expired: 'Expired', missing: 'Needed', '7': 'Soon', '30': 'This month', '60': 'Coming up', ok: 'Current' };
/** A cert's countdown colour: green when current, then yellow, orange, red, and red for expired. */
export function StageBadge({ stage, daysLeft }: { stage: Stage; daysLeft?: number | null }) {
  const cls = stage === 'expired' || stage === 'missing' ? 'bad' : stage === 'ok' ? 'good' : Number(stage) <= 7 ? 'bad' : Number(stage) <= 30 ? 'warn' : 'soon';
  return (
    <span className={`wk-stage ${cls}`}>
      {daysLeft != null && stage !== 'expired' ? `${daysLeft} ${daysLeft === 1 ? 'day' : 'days'} left` : daysLeft != null && stage === 'expired' ? `Expired ${-daysLeft} ${daysLeft === -1 ? 'day' : 'days'} ago` : STAGE_TEXT[stage] ?? stage}
    </span>
  );
}
export function Seg<T extends string>({ value, options, onChange }: { value: T; options: [NoInfer<T>, string][]; onChange(v: NoInfer<T>): void }) {
  return (
    <div className="wk-seg">
      {options.map(([id, label]) => (
        <button key={id} className={value === id ? 'on' : ''} onClick={() => onChange(id)}>
          {label}
        </button>
      ))}
    </div>
  );
}
export function Num({ value, onChange, placeholder, min = 0, max, step = 1, className = '' }: { value: number | null | undefined; onChange(v: number | null): void; placeholder?: string; min?: number; max?: number; step?: number; className?: string }) {
  return (
    <input
      className={`input sm wk-num ${className}`}
      type="number"
      inputMode="decimal"
      min={min}
      max={max}
      step={step}
      placeholder={placeholder}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
    />
  );
}
