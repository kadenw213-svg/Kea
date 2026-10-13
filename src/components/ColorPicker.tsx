import { ReactNode } from 'react';
import { MenuButton } from './Popover';

export const PALETTE = [
  '#000000', '#434343', '#666666', '#999999', '#b7b7b7', '#d9d9d9', '#efefef', '#ffffff',
  '#980000', '#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff', '#4a86e8', '#0000ff',
  '#9900ff', '#ff00ff', '#e6b8af', '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3', '#d0e0e3',
  '#c9daf8', '#cfe2f3', '#d9d2e9', '#ead1dc', '#cc4125', '#e06666', '#f6b26b', '#ffd966',
  '#93c47d', '#76a5af', '#6d9eeb', '#6fa8dc', '#8e7cc3', '#c27ba0', '#a61c00', '#cc0000',
  '#e69138', '#f1c232', '#6aa84f', '#45818e', '#3c78d8', '#3d85c6', '#674ea7', '#a64d79'
];

interface Props {
  icon: ReactNode;
  value?: string | null;
  onChange(color: string | null): void;
  title: string;
  allowNone?: boolean;
  noneLabel?: string;
}

export function ColorPicker({ icon, value, onChange, title, allowNone, noneLabel = 'None' }: Props) {
  return (
    <MenuButton
      title={title}
      button={(open) => (
        <button className={`icon-btn ${open ? 'active' : ''}`}>
          {icon}
          <span
            style={{
              position: 'absolute',
              bottom: 5,
              left: 10,
              right: 10,
              height: 3,
              borderRadius: 2,
              background: value || 'transparent'
            }}
          />
        </button>
      )}
    >
      {(close) => (
        <div>
          {allowNone && (
            <button className="menu-item" onClick={() => (onChange(null), close())}>
              <span className="swatch none" style={{ width: 16, height: 16 }} /> {noneLabel}
            </button>
          )}
          <div className="swatches">
            {PALETTE.map((c) => (
              <button
                key={c}
                className="swatch"
                style={{ background: c, outline: value === c ? '2px solid var(--accent)' : undefined }}
                onClick={() => (onChange(c), close())}
                title={c}
              />
            ))}
          </div>
          <label className="menu-item" style={{ cursor: 'pointer' }}>
            Custom color
            <input
              type="color"
              style={{ marginLeft: 'auto', width: 28, height: 22, border: 'none', background: 'none', padding: 0 }}
              value={value || '#000000'}
              onChange={(e) => onChange(e.target.value)}
            />
          </label>
        </div>
      )}
    </MenuButton>
  );
}
