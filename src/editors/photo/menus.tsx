import { ReactNode } from 'react';
import type { Engine } from './engine';
import { isPixelLayer } from './types';
import { MenuButton } from '../../components/Popover';
import { ADJ_LABELS, ADJ_ORDER, adjDefaults } from './adjustments';
import { FILTER_GROUPS, FILTER_LABELS } from './filters';
import type { DialogSpec } from './dialogs';
import { lastFilterRun } from './dialogs';
import * as ops from './ops';
import { removeBackground } from './segment';
import { toast } from '../../store';

/** File / Edit / Image / Layer / Select / Filter / View menus. */

export interface Commands {
  save(): void;
  saveAs(): void;
  print(): void;
  place(): void;
  copyImage(): void;
  makePdf(): void;
  dialog(d: DialogSpec): void;
  lastFilter(): void;
}

const act = (fn: () => unknown) => {
  try {
    const r = fn();
    if (r instanceof Promise) r.catch((err) => toast(err?.message || String(err), 'error'));
  } catch (err: any) {
    toast(err?.message || String(err), 'error');
  }
};

function Menu({ label, children }: { label: string; children: (close: () => void) => ReactNode }) {
  return (
    <MenuButton
      button={(open) => (
        <button className={`ph-menu-btn ${open ? 'on' : ''}`} onMouseDown={(ev) => ev.preventDefault()}>
          {label}
        </button>
      )}
    >
      {(close) => <div className="ph-menu-scroll">{children(close)}</div>}
    </MenuButton>
  );
}

function Item({ label, kbd, onClick, close, disabled, check }: { label: string; kbd?: string; onClick(): void; close(): void; disabled?: boolean; check?: boolean }) {
  return (
    <button
      className="menu-item"
      disabled={disabled}
      onClick={() => {
        close();
        act(onClick);
      }}
    >
      <span className="ph-check-mark">{check ? '✓' : ''}</span>
      {label}
      {kbd && <span className="kbd">{kbd}</span>}
    </button>
  );
}
const Sep = () => <div className="menu-sep" />;
const Title = ({ children }: { children: ReactNode }) => <div className="menu-title">{children}</div>;

export function MenuBar({ e, cmd }: { e: Engine; cmd: Commands }) {
  const l = e.active;
  const pixel = isPixelLayer(l);
  const sel = !!e.selection;
  return (
    <div className="ph-menus">
      <Menu label="File">
        {(c) => (
          <>
            <Item close={c} label="New image…" onClick={() => cmd.dialog({ kind: 'new' })} />
            <Item close={c} label="Place image as layer…" onClick={cmd.place} />
            <Sep />
            <Item close={c} label="Save" kbd="Ctrl+S" onClick={cmd.save} />
            <Item close={c} label="Save as…" kbd="Ctrl+Shift+S" onClick={cmd.saveAs} />
            <Item close={c} label="Export a copy…" kbd="Ctrl+Alt+Shift+W" onClick={() => cmd.dialog({ kind: 'export', tabName: '' })} />
            <Sep />
            <Item close={c} label="Copy image to clipboard" onClick={cmd.copyImage} />
            <Item close={c} label="Make PDF" onClick={cmd.makePdf} />
            <Item close={c} label="Print…" kbd="Ctrl+P" onClick={cmd.print} />
          </>
        )}
      </Menu>
      <Menu label="Edit">
        {(c) => (
          <>
            <Item close={c} label={e.history.canUndo ? `Undo ${e.history.entries[e.history.index].label}` : 'Undo'} kbd="Ctrl+Z" disabled={!e.history.canUndo && !e.transform} onClick={() => e.undo()} />
            <Item close={c} label={e.history.canRedo ? `Redo ${e.history.entries[e.history.index + 1].label}` : 'Redo'} kbd="Ctrl+Shift+Z" disabled={!e.history.canRedo} onClick={() => e.redo()} />
            <Item close={c} label={`Fade${e.lastFilter && ops.canFade(e) ? ` ${e.lastFilter.label}` : ''}…`} kbd="Ctrl+Shift+F" disabled={!ops.canFade(e)} onClick={() => cmd.dialog({ kind: 'fade' })} />
            <Sep />
            <Item close={c} label="Cut" kbd="Ctrl+X" disabled={!pixel} onClick={() => ops.cut(e)} />
            <Item close={c} label="Copy" kbd="Ctrl+C" disabled={!pixel} onClick={() => ops.copy(e)} />
            <Item close={c} label="Copy merged" kbd="Ctrl+Shift+C" onClick={() => ops.copy(e, true)} />
            <Item close={c} label="Paste" kbd="Ctrl+V" onClick={() => ops.paste(e)} />
            <Item close={c} label="Clear" kbd="Delete" disabled={!sel} onClick={() => ops.clearSelected(e)} />
            <Sep />
            <Item close={c} label="Fill…" kbd="Shift+F5" onClick={() => cmd.dialog({ kind: 'fill' })} />
            <Item close={c} label="Stroke…" disabled={!sel} onClick={() => cmd.dialog({ kind: 'stroke' })} />
            <Sep />
            <Item close={c} label="Free transform" kbd="Ctrl+T" disabled={!pixel} onClick={() => ops.beginTransform(e)} />
            <Item close={c} label="Flip layer horizontal" disabled={!pixel} onClick={() => ops.flipLayer(e, 'h')} />
            <Item close={c} label="Flip layer vertical" disabled={!pixel} onClick={() => ops.flipLayer(e, 'v')} />
          </>
        )}
      </Menu>
      <Menu label="Image">
        {(c) => (
          <>
            <Title>Adjustments (change the layer’s pixels)</Title>
            {ADJ_ORDER.map((t) => (
              <Item key={t} close={c} label={`${ADJ_LABELS[t]}…`} kbd={{ levels: 'Ctrl+L', curves: 'Ctrl+M', hueSat: 'Ctrl+U', colorBalance: 'Ctrl+B', invert: 'Ctrl+I' }[t as string]} disabled={!pixel} onClick={() => (t === 'invert' ? ops.applyAdjustmentPixels(e, adjDefaults('invert')) : cmd.dialog({ kind: 'adjust', type: t }))} />
            ))}
            <Item close={c} label="Desaturate" kbd="Ctrl+Shift+U" disabled={!pixel} onClick={() => ops.applyAdjustmentPixels(e, { ...adjDefaults('hueSat'), saturation: -100 })} />
            <Sep />
            <Item close={c} label="Image size…" kbd="Ctrl+Alt+I" onClick={() => cmd.dialog({ kind: 'imageSize' })} />
            <Item close={c} label="Canvas size…" kbd="Ctrl+Alt+C" onClick={() => cmd.dialog({ kind: 'canvasSize' })} />
            <Sep />
            <Item close={c} label="Rotate 90° clockwise" onClick={() => ops.rotateImage(e, 90)} />
            <Item close={c} label="Rotate 90° counter-clockwise" onClick={() => ops.rotateImage(e, 270)} />
            <Item close={c} label="Rotate 180°" onClick={() => ops.rotateImage(e, 180)} />
            <Item close={c} label="Rotate by angle…" onClick={() => cmd.dialog({ kind: 'rotate' })} />
            <Item close={c} label="Flip canvas horizontal" onClick={() => ops.flipImage(e, 'h')} />
            <Item close={c} label="Flip canvas vertical" onClick={() => ops.flipImage(e, 'v')} />
            <Sep />
            <Item close={c} label="Crop to selection" disabled={!sel} onClick={() => ops.cropTo(e, e.selection!.bounds)} />
            <Item close={c} label="Trim transparent edges" onClick={() => ops.trim(e, 'transparent')} />
            <Item close={c} label="Trim top-left colour" onClick={() => ops.trim(e, 'topleft')} />
          </>
        )}
      </Menu>
      <Menu label="Layer">
        {(c) => (
          <>
            <Item close={c} label="New layer" kbd="Ctrl+Shift+N" onClick={() => ops.addLayer(e)} />
            <Item close={c} label="New group" onClick={() => ops.addGroup(e)} />
            <Item close={c} label="Duplicate layer" kbd="Ctrl+J" disabled={!l} onClick={() => ops.duplicateLayer(e)} />
            <Item close={c} label="Delete layer" disabled={!l} onClick={() => ops.deleteLayer(e)} />
            <Sep />
            <Title>New adjustment layer</Title>
            {ADJ_ORDER.map((t) => (
              <Item key={t} close={c} label={ADJ_LABELS[t]} onClick={() => ops.addAdjustmentLayer(e, adjDefaults(t))} />
            ))}
            <Sep />
            <Title>Layer mask</Title>
            <Item close={c} label="Reveal all" disabled={!l || !!l.mask} onClick={() => ops.addMask(e, 'reveal')} />
            <Item close={c} label="Hide all" disabled={!l || !!l.mask} onClick={() => ops.addMask(e, 'hide')} />
            <Item close={c} label="From selection" disabled={!l || !!l.mask || !sel} onClick={() => ops.addMask(e, 'selection')} />
            <Item close={c} label={l?.mask && !l.mask.enabled ? 'Enable mask' : 'Disable mask'} disabled={!l?.mask} onClick={() => ops.toggleMask(e)} />
            <Item close={c} label="Apply mask" disabled={!l?.mask || !pixel} onClick={() => ops.deleteMask(e, true)} />
            <Item close={c} label="Delete mask" disabled={!l?.mask} onClick={() => ops.deleteMask(e, false)} />
            <Sep />
            <Title>AI</Title>
            <Item close={c} label="Remove background" disabled={!pixel} onClick={() => removeBackground(e, 'erase')} />
            <Item close={c} label="Remove background as mask" disabled={!pixel} onClick={() => removeBackground(e, 'mask')} />
            <Sep />
            <Item close={c} label={l?.clip ? 'Release clipping mask' : 'Create clipping mask'} kbd="Ctrl+Alt+G" disabled={!l} onClick={() => ops.toggleClip(e)} />
            <Item close={c} label="Group layer" kbd="Ctrl+G" disabled={!l} onClick={() => ops.groupActive(e)} />
            <Item close={c} label="Ungroup" kbd="Ctrl+Shift+G" disabled={l?.kind !== 'group'} onClick={() => ops.ungroup(e)} />
            <Item close={c} label="Bring forward" kbd="Ctrl+]" disabled={!l} onClick={() => ops.shiftOrder(e, 1)} />
            <Item close={c} label="Send backward" kbd="Ctrl+[" disabled={!l} onClick={() => ops.shiftOrder(e, -1)} />
            <Sep />
            <Item close={c} label="Rasterize" disabled={l?.kind !== 'text' && l?.kind !== 'shape'} onClick={() => ops.rasterizeActive(e)} />
            <Item close={c} label="Merge down" kbd="Ctrl+E" disabled={!l} onClick={() => ops.mergeDown(e)} />
            <Item close={c} label="Merge visible" kbd="Ctrl+Shift+E" onClick={() => ops.mergeVisible(e)} />
            <Item close={c} label="Flatten image" onClick={() => ops.flatten(e)} />
          </>
        )}
      </Menu>
      <Menu label="Select">
        {(c) => (
          <>
            <Item close={c} label="All" kbd="Ctrl+A" onClick={() => ops.selectAll(e)} />
            <Item close={c} label="Deselect" kbd="Ctrl+D" disabled={!sel} onClick={() => ops.deselect(e)} />
            <Item close={c} label="Inverse" kbd="Ctrl+Shift+I" onClick={() => ops.invertSelection(e)} />
            <Item close={c} label="Layer pixels" disabled={!pixel} onClick={() => ops.selectLayerPixels(e, l!.id)} />
            <Item close={c} label="Subject (AI)" disabled={!pixel} onClick={() => removeBackground(e, 'selection')} />
            <Item close={c} label="Color range…" onClick={() => cmd.dialog({ kind: 'colorRange' })} />
            <Sep />
            <Item close={c} label="Feather…" kbd="Shift+F6" disabled={!sel} onClick={() => cmd.dialog({ kind: 'modify', op: 'feather' })} />
            <Item close={c} label="Expand…" disabled={!sel} onClick={() => cmd.dialog({ kind: 'modify', op: 'expand' })} />
            <Item close={c} label="Contract…" disabled={!sel} onClick={() => cmd.dialog({ kind: 'modify', op: 'contract' })} />
            <Item close={c} label="Border…" disabled={!sel} onClick={() => cmd.dialog({ kind: 'modify', op: 'border' })} />
            <Sep />
            <Item
              close={c}
              label="Show selection edges"
              kbd="Ctrl+H"
              check={e.showSelection}
              onClick={() => {
                e.showSelection = !e.showSelection;
                e.requestFrame();
                e.emit();
              }}
            />
          </>
        )}
      </Menu>
      <Menu label="Filter">
        {(c) => (
          <>
            <Item close={c} label={lastFilterRun ? `Again: ${FILTER_LABELS[lastFilterRun.type]}` : 'Repeat last filter'} kbd="Ctrl+Alt+F" disabled={!lastFilterRun || !pixel} onClick={cmd.lastFilter} />
            {FILTER_GROUPS.map((g) => (
              <div key={g.label}>
                <Title>{g.label}</Title>
                {g.items.map((t) => (
                  <Item key={t} close={c} label={`${FILTER_LABELS[t]}${t === 'edges' ? '' : '…'}`} disabled={!pixel} onClick={() => cmd.dialog({ kind: 'filter', type: t })} />
                ))}
              </div>
            ))}
          </>
        )}
      </Menu>
      <Menu label="View">
        {(c) => (
          <>
            <Item close={c} label="Zoom in" kbd="Ctrl++" onClick={() => e.zoomStep(1)} />
            <Item close={c} label="Zoom out" kbd="Ctrl+-" onClick={() => e.zoomStep(-1)} />
            <Item close={c} label="Fit on screen" kbd="Ctrl+0" onClick={() => e.fitView()} />
            <Item close={c} label="100%" kbd="Ctrl+1" onClick={() => e.zoomTo(1)} />
            <Item close={c} label="200%" onClick={() => e.zoomTo(2)} />
            <Sep />
            <Item
              close={c}
              label="Grid"
              kbd="Ctrl+'"
              check={e.showGrid}
              onClick={() => {
                e.showGrid = !e.showGrid;
                e.requestFrame();
                e.emit();
              }}
            />
            <Item
              close={c}
              label="Rulers"
              kbd="Ctrl+R"
              check={e.showRulers}
              onClick={() => {
                e.showRulers = !e.showRulers;
                e.requestFrame();
                e.emit();
              }}
            />
            {[25, 50, 100, 200].map((g) => (
              <Item
                key={g}
                close={c}
                label={`Grid every ${g} px`}
                check={e.gridSize === g}
                onClick={() => {
                  e.gridSize = g;
                  e.showGrid = true;
                  e.requestFrame();
                  e.emit();
                }}
              />
            ))}
          </>
        )}
      </Menu>
    </div>
  );
}

