import { useState } from 'react';
import { X, Eye, EyeOff } from 'lucide-react';
import type { Protection } from '../../lib/pdfSecurity';

/** Set, change or remove a PDF's password and permissions. */
export function PasswordDialog({ current, onSave, onRemove, onClose }: { current: Protection | null; onSave(p: Protection): void; onRemove(): void; onClose(): void }) {
  const [pw, setPw] = useState(current?.userPassword || '');
  const [pw2, setPw2] = useState(current?.userPassword || '');
  const [show, setShow] = useState(false);
  const [owner, setOwner] = useState(current?.ownerPassword || '');
  const [print, setPrint] = useState(current?.allowPrint ?? true);
  const [copy, setCopy] = useState(current?.allowCopy ?? true);
  const [edit, setEdit] = useState(current?.allowEdit ?? true);
  const [adv, setAdv] = useState(false);
  const mismatch = pw !== pw2;
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog doc-dialog">
        <div className="ai-settings-head">
          <h2>{current ? 'Password protection' : 'Protect with a password'}</h2>
          <button className="icon-btn sm" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <p className="muted" style={{ fontSize: 13 }}>
          Anyone opening this PDF will need the password. It's encrypted with AES-256 when you save. If you forget the password, the file can't be opened, so keep it somewhere safe.
        </p>
        <div className="dd-grid">
          <label>Password</label>
          <span className="dd-row">
            <input className="input sm" type={show ? 'text' : 'password'} value={pw} autoFocus onChange={(e) => setPw(e.target.value)} />
            <button className="icon-btn sm" title={show ? 'Hide' : 'Show'} onClick={() => setShow(!show)}>
              {show ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </span>
          <label>Type it again</label>
          <input className="input sm" type={show ? 'text' : 'password'} value={pw2} onChange={(e) => setPw2(e.target.value)} />
        </div>
        {mismatch && pw2 && <div className="drive-err" style={{ marginTop: 6, fontSize: 12.5 }}>The passwords don't match.</div>}
        <button className="link-btn" style={{ marginTop: 10 }} onClick={() => setAdv(!adv)}>
          {adv ? 'Hide' : 'Show'} permissions (advanced)
        </button>
        {adv && (
          <div style={{ marginTop: 8 }}>
            <label className="hf-check">
              <input type="checkbox" checked={print} onChange={(e) => setPrint(e.target.checked)} /> Allow printing
            </label>
            <label className="hf-check">
              <input type="checkbox" checked={copy} onChange={(e) => setCopy(e.target.checked)} /> Allow copying text
            </label>
            <label className="hf-check">
              <input type="checkbox" checked={edit} onChange={(e) => setEdit(e.target.checked)} /> Allow changes and comments
            </label>
            <div className="dd-grid">
              <label>Owner password</label>
              <input className="input sm" type="password" value={owner} placeholder="Optional: lifts the limits above" onChange={(e) => setOwner(e.target.value)} />
            </div>
          </div>
        )}
        <div className="dialog-actions">
          {current && (
            <button className="btn danger" onClick={() => (onRemove(), onClose())}>
              Remove password
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!pw || mismatch} onClick={() => (onSave({ userPassword: pw, ownerPassword: owner || undefined, allowPrint: print, allowCopy: copy, allowEdit: edit }), onClose())}>
            Protect
          </button>
        </div>
      </div>
    </div>
  );
}
