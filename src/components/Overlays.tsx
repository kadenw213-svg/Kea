import { useEffect, useRef, useState } from 'react';
import { useUi, DialogRequest } from '../store';

function Dialog({ d }: { d: DialogRequest }) {
  const [value, setValue] = useState(d.input?.value ?? '');
  const inputRef = useRef<HTMLInputElement>(null);
  const valueRef = useRef(value);
  valueRef.current = value;

  const finish = (button: string) => {
    useUi.getState().popDialog(d.id);
    d.resolve({ button, value: valueRef.current });
  };
  const primary = d.buttons?.find((b) => b.primary)?.id || 'ok';

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        finish('cancel');
      } else if (e.key === 'Enter' && d.input) {
        e.preventDefault();
        finish(primary);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && finish('cancel')}>
      <div className="dialog" role="dialog">
        <h2>{d.title}</h2>
        {d.message && <p>{d.message}</p>}
        {d.input && (
          <div>
            {d.input.label && <label className="field-label">{d.input.label}</label>}
            <input
              ref={inputRef}
              className="input"
              autoFocus
              value={value}
              placeholder={d.input.placeholder}
              onChange={(e) => setValue(e.target.value)}
            />
          </div>
        )}
        <div className="dialog-actions">
          {(d.buttons || [{ id: 'ok', label: 'OK', primary: true }]).map((b) => (
            <button
              key={b.id}
              className={`btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''}`}
              onClick={() => finish(b.id)}
              autoFocus={!d.input && b.primary}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function Overlays() {
  const dialogs = useUi((s) => s.dialogs);
  const toasts = useUi((s) => s.toasts);
  return (
    <>
      {dialogs.length > 0 && <Dialog key={dialogs[0].id} d={dialogs[0]} />}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.message}
          </div>
        ))}
      </div>
    </>
  );
}
