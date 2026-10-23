import { useEffect, useRef, useState, ReactNode } from 'react';
import { Diamond, ChevronLeft, ChevronRight, X, RotateCcw, FlipHorizontal2, FlipVertical2, Pipette, Wand2, Trash2, Bold, Italic, AlignLeft, AlignCenter, AlignRight, Volume2 } from 'lucide-react';
import type { Player } from './player';
import type { Project, Clip, AnimProp, Colour, Ease, TextStyle, ShapeStyle, ShapeKind, BlendMode, TransitionType, TextAnim } from './model';
import {
  BLEND_MODES,
  COLOUR_PRESETS,
  NEUTRAL_COLOUR,
  EASES,
  FONTS,
  TEXT_ANIMS,
  TRANSITIONS,
  TRANSITION_DIRS,
  DIRECTIONAL,
  DEFAULT_PROPS,
  DEFAULT_CROP,
  DEFAULT_KEY,
  propAt,
  setKey,
  clipDuration,
  clipEnd,
  mediaOf,
  trackOf,
  trackClips,
  EPS
} from './model';
import { maxTransition, setTransition, partners } from './ops';
import { frameTime, sizeOf } from './compositor';
import { guessKeyColour } from './effects';
import { peaksFor } from './media';
import { buildMasks } from './segmentMask';
import { loadLut, getLut } from './lut';
import { api } from '../../lib/api';
import { startJob, jobStatus } from '../../lib/jobs';
import { useVE, useVEStore } from './state';
import { toast } from '../../store';
import { clamp } from '../../lib/util';
import './inspector.css';

type TabId = 'video' | 'colour' | 'key' | 'speed' | 'text' | 'shape' | 'audio';
const TAB_LABEL: Record<TabId, string> = { video: 'Video', colour: 'Colour', key: 'Key', speed: 'Speed', text: 'Text', shape: 'Shape', audio: 'Audio' };

const find = (p: Project, id: string) => p.clips.find((c) => c.id === id);

/** Set a number property: a keyframe at the playhead when it's animated, else the static value. */
function setAnim(p: Project, id: string, prop: AnimProp, v: number, t: number) {
  const c = find(p, id);
  if (!c) return;
  if (c.kf[prop]?.length) setKey(c, prop, clamp(t - c.start, 0, clipDuration(c)), v);
  else c.props[prop] = v;
}

export function applyColourPreset(c: Clip, presetId: string) {
  const pr = COLOUR_PRESETS.find((x) => x.id === presetId);
  c.colour = { ...NEUTRAL_COLOUR, ...(pr?.c || {}) };
}

/** Change speed keeping the in point; the clip can't grow into the next clip on its track. */
function applySpeed(p: Project, ids: string[], speed: number) {
  for (const id of ids) {
    const c = find(p, id);
    if (!c) continue;
    const end = clipEnd(c);
    const next = trackClips(p, c.trackId).find((x) => x.id !== c.id && x.start >= end - 1e-3);
    const limit = next ? next.start - c.start : Infinity;
    let len = (c.out - c.in) / speed;
    if (len > limit) {
      c.out = c.in + limit * speed;
      len = limit;
    }
    c.speed = speed;
    c.ramp = undefined; // a constant speed replaces any ramp
  }
}

/* ---------- Small controls ---------- */

function NumBox({ value, digits = 0, min, max, onCommit, title }: { value: number; digits?: number; min?: number; max?: number; onCommit(v: number): void; title?: string }) {
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? (Number.isFinite(value) ? value.toFixed(digits) : '');
  const done = () => {
    if (text === null) return;
    const v = parseFloat(text);
    setText(null);
    if (!Number.isNaN(v)) onCommit(clamp(v, min ?? -Infinity, max ?? Infinity));
  };
  return (
    <input
      className="ve-insp-num"
      value={shown}
      title={title}
      onChange={(e) => setText(e.target.value)}
      onBlur={done}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setText(null);
        e.stopPropagation();
      }}
    />
  );
}

/** Label, range and number box. Dragging is one undo step; typing or arrow keys commit straight away. */
function Slider(props: {
  label: string;
  undo: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  digits?: number;
  /** Let the number box go past the slider's range. */
  free?: boolean;
  apply(p: Project, v: number): void;
  extra?: ReactNode;
  title?: string;
}) {
  const store = useVEStore();
  const drag = useRef(false);
  const run = (v: number, live: boolean) => {
    const s = store.getState();
    if (live) s.live((p) => props.apply(p, v));
    else s.commit(props.undo, (p) => props.apply(p, v));
  };
  const start = () => {
    drag.current = true;
    store.getState().begin(props.undo);
    const up = () => {
      drag.current = false;
      store.getState().end();
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointerup', up);
  };
  return (
    <div className="ve-insp-row" title={props.title}>
      <span className="ve-insp-label">{props.label}</span>
      <input
        type="range"
        className="ve-insp-range"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={clamp(props.value, props.min, props.max)}
        onPointerDown={start}
        onChange={(e) => run(+e.target.value, drag.current)}
        onKeyDown={(e) => e.stopPropagation()}
      />
      <NumBox value={props.value} digits={props.digits ?? 0} min={props.free ? undefined : props.min} max={props.free ? undefined : props.max} onCommit={(v) => run(v, false)} />
      <span className="ve-insp-unit">{props.unit || ''}</span>
      <span className="ve-insp-extra">{props.extra}</span>
    </div>
  );
}

/** A colour well; the picker's dragging is one undo step. With `allowNone`, '' means no colour. */
function ColourInput({ label, value, undo, apply, allowNone }: { label: string; value: string; undo: string; apply(p: Project, v: string): void; allowNone?: boolean }) {
  const store = useVEStore();
  const ref = useRef<HTMLInputElement>(null);
  const active = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const finish = () => {
      if (active.current) store.getState().end();
      active.current = false;
    };
    el.addEventListener('change', finish);
    el.addEventListener('blur', finish);
    return () => {
      el.removeEventListener('change', finish);
      el.removeEventListener('blur', finish);
    };
  }, [store]);
  return (
    <div className="ve-insp-row">
      <span className="ve-insp-label">{label}</span>
      <div className="ve-insp-colour">
        <input
          ref={ref}
          type="color"
          className={value ? '' : 'none'}
          value={value || '#000000'}
          onChange={(e) => {
            const v = e.target.value;
            if (!active.current) {
              active.current = true;
              store.getState().begin(undo);
            }
            store.getState().live((p) => apply(p, v));
          }}
        />
        {allowNone && (
          <button className={`ve-insp-chip ${value ? '' : 'on'}`} title="No colour" onClick={() => store.getState().commit(undo, (p) => apply(p, ''))}>
            None
          </button>
        )}
        <span className="ve-insp-hex">{value ? value.toUpperCase() : 'None'}</span>
      </div>
    </div>
  );
}

function Section({ title, onReset, children }: { title: string; onReset?: () => void; children: ReactNode }) {
  return (
    <div className="ve-insp-section">
      <div className="ve-insp-section-head">
        <span>{title}</span>
        {onReset && (
          <button className="ve-insp-icon" title={`Reset ${title.toLowerCase()}`} onClick={onReset}>
            <RotateCcw size={13} />
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

function Select<T extends string>({ label, value, options, onChange, title }: { label: string; value: T; options: { id: T; label: string }[]; onChange(v: T): void; title?: string }) {
  return (
    <div className="ve-insp-row" title={title}>
      <span className="ve-insp-label">{label}</span>
      <select className="ve-insp-select" value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function Check({ label, checked, onChange, title }: { label: string; checked: boolean; onChange(v: boolean): void; title?: string }) {
  return (
    <label className="ve-insp-check" title={title}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

/** Text field whose whole editing session (focus → blur) is one undo step. */
function LiveText({ value, undo, apply, multiline, className }: { value: string; undo: string; apply(p: Project, v: string): void; multiline?: boolean; className?: string }) {
  const store = useVEStore();
  const active = useRef(false);
  const onChange = (v: string) => {
    if (!active.current) {
      active.current = true;
      store.getState().begin(undo);
    }
    store.getState().live((p) => apply(p, v));
  };
  const onBlur = () => {
    if (active.current) store.getState().end();
    active.current = false;
  };
  const common = {
    className,
    value,
    onBlur,
    onKeyDown: (e: React.KeyboardEvent) => {
      e.stopPropagation();
      if (!multiline && e.key === 'Enter') (e.target as HTMLElement).blur();
    }
  };
  return multiline ? <textarea {...common} rows={3} onChange={(e) => onChange(e.target.value)} /> : <input {...common} onChange={(e) => onChange(e.target.value)} />;
}

/* ---------- Keyframe buttons ---------- */

function KeyControls({ clip, prop, label, player }: { clip: Clip; prop: AnimProp; label: string; player: Player }) {
  const store = useVEStore();
  const playhead = useVE((s) => s.playhead);
  const fps = useVE((s) => s.project.settings.fps);
  const keys = clip.kf[prop] || [];
  const rel = playhead - clip.start;
  const tol = 0.5 / fps;
  const at = keys.find((k) => Math.abs(k.t - rel) < tol);
  const seek = (t: number) => {
    if (player.playing) player.pause();
    store.getState().seek(clip.start + t);
  };
  const relClamped = clamp(rel, 0, clipDuration(clip));
  if (!keys.length)
    return (
      <button
        className="ve-insp-icon"
        title={`Animate ${label.toLowerCase()} (adds a keyframe at the playhead)`}
        onClick={() =>
          store.getState().commit(`Animate ${label.toLowerCase()}`, (p) => {
            const c = find(p, clip.id)!;
            setKey(c, prop, relClamped, propAt(c, prop, playhead));
          })
        }
      >
        <Diamond size={12} />
      </button>
    );
  const prev = [...keys].reverse().find((k) => k.t < rel - tol);
  const next = keys.find((k) => k.t > rel + tol);
  return (
    <span className="ve-insp-keys">
      <button className="ve-insp-icon" disabled={!prev} title="Previous keyframe" onClick={() => prev && seek(prev.t)}>
        <ChevronLeft size={12} />
      </button>
      <button
        className={`ve-insp-icon key ${at ? 'on' : ''}`}
        title={at ? 'Remove this keyframe' : 'Add a keyframe at the playhead'}
        onClick={() =>
          store.getState().commit(at ? 'Remove keyframe' : 'Add keyframe', (p) => {
            const c = find(p, clip.id)!;
            const v = propAt(c, prop, playhead);
            if (at) {
              const left = (c.kf[prop] || []).filter((k) => Math.abs(k.t - rel) >= tol);
              if (left.length) c.kf[prop] = left;
              else {
                delete c.kf[prop];
                c.props[prop] = v;
              }
            } else setKey(c, prop, relClamped, v);
          })
        }
      >
        <Diamond size={12} fill={at ? 'currentColor' : 'none'} />
      </button>
      <button className="ve-insp-icon" disabled={!next} title="Next keyframe" onClick={() => next && seek(next.t)}>
        <ChevronRight size={12} />
      </button>
      <button
        className="ve-insp-icon"
        title="Remove animation (keeps the current value)"
        onClick={() =>
          store.getState().commit(`Stop animating ${label.toLowerCase()}`, (p) => {
            const c = find(p, clip.id)!;
            const v = propAt(c, prop, playhead);
            delete c.kf[prop];
            c.props[prop] = v;
          })
        }
      >
        <X size={12} />
      </button>
    </span>
  );
}

/** A slider for an animatable property, with keyframe buttons and the easing of the keyframe under the playhead. */
function AnimSlider(props: { clip: Clip; prop: AnimProp; label: string; min: number; max: number; step?: number; unit?: string; digits?: number; free?: boolean; player: Player }) {
  const { clip, prop, label } = props;
  const store = useVEStore();
  const playhead = useVE((s) => s.playhead);
  const fps = useVE((s) => s.project.settings.fps);
  const keys = clip.kf[prop] || [];
  const rel = playhead - clip.start;
  const atIdx = keys.findIndex((k) => Math.abs(k.t - rel) < 0.5 / fps);
  return (
    <>
      <Slider
        label={label}
        undo={`Change ${label.toLowerCase()}`}
        value={propAt(clip, prop, playhead)}
        min={props.min}
        max={props.max}
        step={props.step}
        unit={props.unit}
        digits={props.digits}
        free={props.free}
        apply={(p, v) => setAnim(p, clip.id, prop, v, playhead)}
        extra={<KeyControls clip={clip} prop={prop} label={label} player={props.player} />}
      />
      {atIdx >= 0 && atIdx < keys.length - 1 && (
        <div className="ve-insp-row sub">
          <span className="ve-insp-label">Easing</span>
          <select
            className="ve-insp-select"
            value={keys[atIdx].ease}
            title="How the value moves to the next keyframe"
            onChange={(e) =>
              store.getState().commit('Change easing', (p) => {
                const c = find(p, clip.id)!;
                const k = [...(c.kf[prop] || [])];
                k[atIdx] = { ...k[atIdx], ease: e.target.value as Ease };
                c.kf[prop] = k;
              })
            }
          >
            {EASES.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </select>
        </div>
      )}
    </>
  );
}

/* ---------- The panel ---------- */

export function Inspector({ player }: { player: Player }) {
  const project = useVE((s) => s.project);
  const sel = useVE((s) => s.sel);
  const selTr = useVE((s) => s.selTransition);
  const clip = sel.length ? find(project, sel[0]) : undefined;

  let body: ReactNode;
  let title = 'Project';
  if (selTr) {
    title = 'Transition';
    body = <TransitionPanel />;
  } else if (clip) {
    title = clip.kind === 'text' ? 'Text' : clip.kind === 'shape' ? 'Shape' : trackOf(project, clip)?.kind === 'audio' ? 'Audio clip' : 'Clip';
    body = <ClipPanel key={clip.id} clip={clip} count={sel.length} player={player} />;
  } else {
    const s = project.settings;
    body = (
      <>
        <Section title="Project">
          <div className="ve-insp-facts">
            <span>Size</span>
            <b>
              {s.width} × {s.height}
            </b>
            <span>Frame rate</span>
            <b>{s.fps} fps</b>
            <span>Shape</span>
            <b>{s.aspect === 'custom' ? 'Custom' : s.aspect}</b>
            <span>Media</span>
            <b>{project.media.length} files</b>
            <span>Clips</span>
            <b>{project.clips.length}</b>
          </div>
          <ColourInput
            label="Background"
            value={s.background}
            undo="Change background"
            apply={(p, v) => {
              p.settings.background = v || '#000000';
            }}
          />
        </Section>
        <div className="ve-insp-hint">Select a clip to change it.</div>
      </>
    );
  }
  return (
    <div className="ve-insp">
      <div className="ve-insp-head">{title}</div>
      <div className="ve-insp-body">{body}</div>
    </div>
  );
}

function TransitionPanel() {
  const store = useVEStore();
  const project = useVE((s) => s.project);
  const ref = useVE((s) => s.selTransition)!;
  const c = find(project, ref.clipId);
  const tr = c ? (ref.edge === 'in' ? c.trIn : c.trOut) : undefined;
  if (!c || !tr) return <div className="ve-insp-hint">This transition was removed.</div>;
  const max = Math.max(0.1, maxTransition(project, c, ref.edge));
  const info = TRANSITIONS.find((x) => x.id === tr.type);
  return (
    <Section title={info?.label || 'Transition'}>
      <Select<TransitionType>
        label="Type"
        value={tr.type}
        options={TRANSITIONS.map((x) => ({ id: x.id, label: x.label }))}
        onChange={(v) => store.getState().commit('Change transition', (p) => void setTransition(p, c.id, ref.edge, { ...tr, type: v }))}
      />
      {DIRECTIONAL[tr.type] && (
        <Select<string>
          label="Direction"
          value={tr.dir || DIRECTIONAL[tr.type]!}
          options={TRANSITION_DIRS.map((d) => ({ id: d, label: d[0].toUpperCase() + d.slice(1) }))}
          onChange={(v) => store.getState().commit('Change transition direction', (p) => void setTransition(p, c.id, ref.edge, { ...tr, dir: v as any }))}
        />
      )}
      <Slider
        label="Length"
        undo="Change transition length"
        value={tr.duration}
        min={0.1}
        max={max}
        step={0.05}
        digits={2}
        unit="s"
        apply={(p, v) => void setTransition(p, c.id, ref.edge, { ...tr, duration: v })}
      />
      {info && <div className="ve-insp-hint left">{info.hint}</div>}
      <button
        className="btn tonal sm ve-insp-wide"
        onClick={() => {
          store.getState().commit('Remove transition', (p) => void setTransition(p, c.id, ref.edge, null));
          store.getState().set({ selTransition: null });
        }}
      >
        <Trash2 size={14} /> Remove transition
      </button>
    </Section>
  );
}

function ClipPanel({ clip, count, player }: { clip: Clip; count: number; player: Player }) {
  const project = useVE((s) => s.project);
  const track = trackOf(project, clip);
  const isAudio = track?.kind === 'audio';
  const media = mediaOf(project, clip);
  const audioClip = isAudio ? clip : partners(project, clip).find((x) => trackOf(project, x)?.kind === 'audio');

  const tabs: TabId[] = [];
  if (!isAudio) {
    if (clip.kind === 'text') tabs.push('text');
    if (clip.kind === 'shape') tabs.push('shape');
    tabs.push('video');
    if (clip.kind === 'media') tabs.push('colour', 'key');
    if (media?.kind === 'video') tabs.push('speed');
  }
  if (audioClip) tabs.push('audio');
  if (isAudio) tabs.push('speed');
  const [tab, setTab] = useState<TabId>(tabs[0]);
  const cur = tabs.includes(tab) ? tab : tabs[0];

  return (
    <>
      <div className="ve-insp-name">
        <LiveText
          className="ve-insp-name-input"
          value={clip.name}
          undo="Rename clip"
          apply={(p, v) => {
            const c = find(p, clip.id);
            if (c) c.name = v;
          }}
        />
        {count > 1 && <div className="ve-insp-note">{count} clips selected · showing the first</div>}
        {media && (
          <div className="ve-insp-note" title={media.path}>
            {media.name}
            {media.width ? ` · ${media.width}×${media.height}` : ''}
          </div>
        )}
      </div>
      {tabs.length > 1 && (
        <div className="ve-insp-tabs">
          {tabs.map((t) => (
            <button key={t} className={t === cur ? 'on' : ''} onClick={() => setTab(t)}>
              {TAB_LABEL[t]}
            </button>
          ))}
        </div>
      )}
      {cur === 'video' && <VideoTab clip={clip} player={player} />}
      {cur === 'colour' && <ColourTab clip={clip} />}
      {cur === 'key' && <KeyTab clip={clip} player={player} />}
      {cur === 'speed' && <SpeedTab clip={clip} />}
      {cur === 'text' && clip.text && <TextTab clip={clip} />}
      {cur === 'shape' && clip.shape && <ShapeTab clip={clip} />}
      {cur === 'audio' && audioClip && <AudioTab clip={audioClip} player={player} linked={audioClip !== clip} />}
    </>
  );
}

/* ---------- Tabs ---------- */

function VideoTab({ clip, player }: { clip: Clip; player: Player }) {
  const store = useVEStore();
  const project = useVE((s) => s.project);
  const { width: W, height: H } = project.settings;
  const media = mediaOf(project, clip);
  const edit = (label: string, fn: (c: Clip) => void) =>
    store.getState().commit(label, (p) => {
      const c = find(p, clip.id);
      if (c) fn(c);
    });
  const resetTransform = () =>
    edit('Reset transform', (c) => {
      for (const k of ['x', 'y', 'scale', 'rotation'] as AnimProp[]) {
        delete c.kf[k];
        c.props[k] = DEFAULT_PROPS[k] as number;
      }
      c.props.flipH = false;
      c.props.flipV = false;
    });
  const kenBurns = () =>
    edit('Add Ken Burns', (c) => {
      const d = clipDuration(c);
      c.kf.scale = [
        { t: 0, v: 100, ease: 'inOut' },
        { t: d, v: 115, ease: 'linear' }
      ];
      c.kf.x = [
        { t: 0, v: -W * 0.02, ease: 'inOut' },
        { t: d, v: W * 0.02, ease: 'linear' }
      ];
      c.kf.y = [
        { t: 0, v: H * 0.015, ease: 'inOut' },
        { t: d, v: -H * 0.015, ease: 'linear' }
      ];
    });
  const crop = (side: 'left' | 'right' | 'top' | 'bottom', label: string) => (
    <Slider
      label={label}
      undo="Crop"
      value={clip.crop[side]}
      min={0}
      max={100}
      unit="%"
      apply={(p, v) => {
        const c = find(p, clip.id);
        if (c) c.crop[side] = v;
      }}
    />
  );
  return (
    <>
      <Section title="Transform" onReset={resetTransform}>
        <AnimSlider clip={clip} prop="x" label="Position X" min={-W} max={W} unit="px" free player={player} />
        <AnimSlider clip={clip} prop="y" label="Position Y" min={-H} max={H} unit="px" free player={player} />
        <AnimSlider clip={clip} prop="scale" label="Scale" min={1} max={400} unit="%" free player={player} />
        <AnimSlider clip={clip} prop="rotation" label="Rotation" min={-180} max={180} unit="°" free player={player} />
        <div className="ve-insp-row">
          <span className="ve-insp-label">Flip</span>
          <div className="ve-insp-btns">
            <button className={`ve-insp-icon big ${clip.props.flipH ? 'on' : ''}`} title="Flip horizontally" onClick={() => edit('Flip', (c) => (c.props.flipH = !c.props.flipH))}>
              <FlipHorizontal2 size={15} />
            </button>
            <button className={`ve-insp-icon big ${clip.props.flipV ? 'on' : ''}`} title="Flip vertically" onClick={() => edit('Flip', (c) => (c.props.flipV = !c.props.flipV))}>
              <FlipVertical2 size={15} />
            </button>
          </div>
        </div>
        {media?.kind === 'image' && (
          <button className="btn tonal sm ve-insp-wide" title="Slowly zoom and pan across the picture" onClick={kenBurns}>
            <Wand2 size={14} /> Ken Burns zoom
          </button>
        )}
      </Section>
      <Section
        title="Look"
        onReset={() =>
          edit('Reset look', (c) => {
            delete c.kf.opacity;
            delete c.kf.blur;
            c.props.opacity = 100;
            c.props.blur = 0;
            c.blend = 'normal';
          })
        }
      >
        <AnimSlider clip={clip} prop="opacity" label="Opacity" min={0} max={100} unit="%" player={player} />
        <AnimSlider clip={clip} prop="blur" label="Blur" min={0} max={100} unit="px" player={player} />
        <Select<BlendMode>
          label="Blend"
          value={clip.blend}
          title="How this clip mixes with the tracks under it"
          options={BLEND_MODES.map((b) => ({ id: b, label: b === 'normal' ? 'Normal' : b[0].toUpperCase() + b.slice(1).replace('-', ' ') }))}
          onChange={(v) => edit('Change blend mode', (c) => (c.blend = v))}
        />
      </Section>
      {clip.kind === 'media' && (
        <Section title="Crop" onReset={() => edit('Reset crop', (c) => (c.crop = { ...DEFAULT_CROP }))}>
          {crop('left', 'Left')}
          {crop('right', 'Right')}
          {crop('top', 'Top')}
          {crop('bottom', 'Bottom')}
        </Section>
      )}
    </>
  );
}

const COLOUR_FIELDS: { k: keyof Colour; label: string; min: number; max: number; step?: number; digits?: number; unit?: string }[] = [
  { k: 'exposure', label: 'Exposure', min: -3, max: 3, step: 0.05, digits: 2, unit: 'st' },
  { k: 'contrast', label: 'Contrast', min: -100, max: 100 },
  { k: 'saturation', label: 'Saturation', min: -100, max: 100 },
  { k: 'temperature', label: 'Temperature', min: -100, max: 100 },
  { k: 'tint', label: 'Tint', min: -100, max: 100 },
  { k: 'highlights', label: 'Highlights', min: -100, max: 100 },
  { k: 'shadows', label: 'Shadows', min: -100, max: 100 },
  { k: 'vignette', label: 'Vignette', min: 0, max: 100 }
];

function LutSection({ clip }: { clip: Clip }) {
  const store = useVEStore();
  const [err, setErr] = useState('');
  const choose = async () => {
    const [f] = await api.openDialog({ title: 'Choose a LUT', filters: [{ name: 'LUT', extensions: ['cube'] }] });
    if (!f) return;
    try {
      await loadLut(f.path);
      setErr('');
      store.getState().commit('Apply LUT', (p) => {
        const c = find(p, clip.id);
        if (c) c.lut = { path: f.path, amount: c.lut?.amount ?? 100 };
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Section title="LUT" onReset={clip.lut ? () => store.getState().commit('Remove LUT', (p) => void (find(p, clip.id)!.lut = undefined)) : undefined}>
      <button className="btn tonal sm ve-insp-wide" title="A .cube file: film looks, camera log conversions, LUT packs" onClick={choose}>
        {clip.lut ? `LUT: ${getLut(clip.lut.path)?.title || clip.lut.path.split(/[\\/]/).pop()}` : 'Choose a .cube LUT…'}
      </button>
      {clip.lut && (
        <Slider
          label="Amount"
          undo="Change LUT amount"
          value={clip.lut.amount}
          min={0}
          max={100}
          unit="%"
          apply={(p, v) => {
            const c = find(p, clip.id);
            if (c?.lut) c.lut.amount = v;
          }}
        />
      )}
      {err && <div className="ve-insp-hint left">{err}</div>}
    </Section>
  );
}

function ColourTab({ clip }: { clip: Clip }) {
  const store = useVEStore();
  const active = COLOUR_PRESETS.find((pr) => (Object.keys(NEUTRAL_COLOUR) as (keyof Colour)[]).every((k) => Math.abs((pr.c[k] ?? 0) - clip.colour[k]) < 1e-6));
  return (
    <>
      <LutSection clip={clip} />
      <Section title="Presets">
        <div className="ve-insp-presets">
          {COLOUR_PRESETS.map((pr) => (
            <button
              key={pr.id}
              className={active?.id === pr.id ? 'on' : ''}
              onClick={() =>
                store.getState().commit(`Colour: ${pr.label}`, (p) => {
                  const c = find(p, clip.id);
                  if (c) applyColourPreset(c, pr.id);
                })
              }
            >
              {pr.label}
            </button>
          ))}
        </div>
      </Section>
      <Section
        title="Adjust"
        onReset={() =>
          store.getState().commit('Reset colour', (p) => {
            const c = find(p, clip.id);
            if (c) c.colour = { ...NEUTRAL_COLOUR };
          })
        }
      >
        {COLOUR_FIELDS.map((f) => (
          <Slider
            key={f.k}
            label={f.label}
            undo={`Change ${f.label.toLowerCase()}`}
            value={clip.colour[f.k]}
            min={f.min}
            max={f.max}
            step={f.step}
            digits={f.digits}
            unit={f.unit}
            apply={(p, v) => {
              const c = find(p, clip.id);
              if (c) c.colour[f.k] = v;
            }}
          />
        ))}
      </Section>
    </>
  );
}

function KeyTab({ clip, player }: { clip: Clip; player: Player }) {
  const store = useVEStore();
  const project = useVE((s) => s.project);
  const playhead = useVE((s) => s.playhead);
  const k = clip.key;
  const edit = (label: string, fn: (c: Clip) => void) =>
    store.getState().commit(label, (p) => {
      const c = find(p, clip.id);
      if (c) fn(c);
    });
  const pick = () => {
    if (playhead < clip.start || playhead >= clipEnd(clip)) return toast('Move the playhead over this clip first');
    const f = player.getFrame(clip, frameTime(project, clip, playhead));
    if (!f || f === 'offline') return toast("Couldn't read this frame yet. Try again in a moment.");
    const [w, h] = sizeOf(f);
    if (!w || !h) return toast("Couldn't read this frame yet. Try again in a moment.");
    const color = guessKeyColour(f as CanvasImageSource, w, h);
    edit('Pick key colour', (c) => {
      c.key.color = color;
      c.key.enabled = true;
    });
  };
  const [maskJob, setMaskJob] = useState<string | null>(null);
  const [maskNote, setMaskNote] = useState<string>('');
  useEffect(() => {
    if (!maskJob) return;
    const id = setInterval(() => {
      const s = jobStatus(maskJob) as import('../../lib/jobs').JobView | null;
      if (!s || s.status === 'running') {
        setMaskNote(s ? s.note || `Masking… ${Math.round((s.progress || 0) * 100)}%` : '');
        return;
      }
      clearInterval(id);
      setMaskJob(null);
      if (s.status === 'error') {
        setMaskNote('');
        toast(s.error || s.note || 'Background removal failed.');
      } else {
        setMaskNote('Background removed.');
        setTimeout(() => setMaskNote(''), 2500);
      }
    }, 400);
    return () => clearInterval(id);
  }, [maskJob]);
  const toggleRemoveBg = (on: boolean) => {
    edit(on ? 'Remove background (AI)' : 'Restore background', (c) => (c.removeBg = { enabled: on }));
    if (!on) {
      setMaskJob(null);
      setMaskNote('');
      return;
    }
    const media = mediaOf(project, clip);
    if (!media || media.kind === 'image') return toast('Background removal needs a video clip.');
    try {
      const jobId = startJob('segment', async (onProgress, signal) => buildMasks(media, onProgress, signal));
      setMaskJob(jobId);
      setMaskNote('Masking…');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not start background removal.');
    }
  };
  const num = (field: 'tolerance' | 'softness' | 'spill', label: string, title: string) => (
    <Slider
      label={label}
      undo={`Change key ${label.toLowerCase()}`}
      title={title}
      value={k[field]}
      min={0}
      max={100}
      apply={(p, v) => {
        const c = find(p, clip.id);
        if (c) c.key[field] = v;
      }}
    />
  );
  return (
    <Section title="Green screen" onReset={() => edit('Reset key', (c) => (c.key = { ...DEFAULT_KEY }))}>
      <Check
        label="Remove background (AI) — no green screen"
        checked={!!clip.removeBg?.enabled}
        onChange={toggleRemoveBg}
      />
      {(maskNote || clip.removeBg?.enabled) && <div className="ve-insp-note">{maskNote || 'Background removed (AI).'}</div>}
      <Check label="Remove a background colour" checked={k.enabled} onChange={(v) => edit(v ? 'Turn on key' : 'Turn off key', (c) => (c.key.enabled = v))} />
      <ColourInput
        label="Colour"
        value={k.color}
        undo="Change key colour"
        apply={(p, v) => {
          const c = find(p, clip.id);
          if (c) {
            c.key.color = v;
            c.key.enabled = true;
          }
        }}
      />
      <button className="btn tonal sm ve-insp-wide" title="Find the background colour in the frame under the playhead" onClick={pick}>
        <Pipette size={14} /> Pick from frame
      </button>
      {num('tolerance', 'Tolerance', 'How far from the colour still counts as background')}
      {num('softness', 'Softness', 'How soft the edges are')}
      {num('spill', 'Spill', 'Removes the background tint from edges and hair')}
    </Section>
  );
}

const SPEEDS = [0.25, 0.5, 1, 1.5, 2, 4];

function SpeedTab({ clip }: { clip: Clip }) {
  const store = useVEStore();
  const project = useVE((s) => s.project);
  const group = [clip.id, ...partners(project, clip).map((c) => c.id)];
  const setSpeed = (v: number) => store.getState().commit('Change speed', (p) => applySpeed(p, group, clamp(v, 0.25, 4)));
  const len = clipDuration(clip);
  return (
    <Section title="Speed">
      <Slider label="Speed" undo="Change speed" value={clip.speed} min={0.25} max={4} step={0.05} digits={2} unit="×" apply={(p, v) => applySpeed(p, group, v)} />
      <div className="ve-insp-presets">
        {SPEEDS.map((s) => (
          <button key={s} className={Math.abs(clip.speed - s) < 1e-3 ? 'on' : ''} onClick={() => setSpeed(s)}>
            {s}×
          </button>
        ))}
      </div>
      <div className="ve-insp-note">Length on the timeline: {len.toFixed(2)} s</div>
      {clip.ramp?.length ? (
        <>
          <div className="ve-insp-note">
            Speed ramp: {clip.ramp.map((k) => `${k.v.toFixed(2)}× at ${k.t.toFixed(2)} s`).join(' → ')}
          </div>
          <button
            className="btn tonal sm ve-insp-wide"
            onClick={() =>
              store.getState().commit('Remove speed ramp', (p) => {
                for (const id of group) {
                  const c = p.clips.find((x) => x.id === id);
                  if (c) c.ramp = undefined;
                }
              })
            }
          >
            Remove speed ramp
          </button>
        </>
      ) : null}
      <Check
        label="Play backwards"
        checked={clip.reverse}
        onChange={(v) =>
          store.getState().commit('Reverse', (p) => {
            for (const id of group) {
              const c = find(p, id);
              if (c) c.reverse = v;
            }
          })
        }
      />
      <Check
        label="Keep voice pitch"
        title="Sped-up or slowed-down speech keeps its normal pitch"
        checked={clip.keepPitch}
        onChange={(v) =>
          store.getState().commit('Keep pitch', (p) => {
            for (const id of group) {
              const c = find(p, id);
              if (c) c.keepPitch = v;
            }
          })
        }
      />
      {clip.reverse && <div className="ve-insp-hint left">Reversed sound plays in the export; the preview stays quiet for reversed clips.</div>}
    </Section>
  );
}

function TextTab({ clip }: { clip: Clip }) {
  const store = useVEStore();
  const st = clip.text!;
  const set = (label: string, patch: Partial<TextStyle>) =>
    store.getState().commit(label, (p) => {
      const c = find(p, clip.id);
      if (c?.text) Object.assign(c.text, patch);
    });
  const apply =
    <K extends keyof TextStyle>(k: K) =>
    (p: Project, v: TextStyle[K]) => {
      const c = find(p, clip.id);
      if (c?.text) c.text[k] = v;
    };
  const num = (k: 'size' | 'lineHeight' | 'boxOpacity' | 'boxPadding' | 'boxRadius' | 'outlineWidth' | 'shadowBlur' | 'shadowY' | 'animDuration', label: string, min: number, max: number, step = 1, unit = '', digits = 0) => (
    <Slider label={label} undo={`Change ${label.toLowerCase()}`} value={st[k]} min={min} max={max} step={step} unit={unit} digits={digits} apply={apply(k)} />
  );
  return (
    <>
      <Section title="Text">
        <LiveText
          multiline
          className="ve-insp-textarea"
          value={st.text}
          undo="Edit text"
          apply={(p, v) => {
            const c = find(p, clip.id);
            if (c?.text) {
              c.text.text = v;
              c.name = v.split('\n')[0].slice(0, 40) || 'Text';
            }
          }}
        />
        <Select label="Font" value={st.font} options={FONTS.map((f) => ({ id: f, label: f }))} onChange={(v) => set('Change font', { font: v })} />
        {num('size', 'Size', 8, 400, 1, 'px')}
        <ColourInput label="Colour" value={st.color} undo="Change text colour" apply={(p, v) => apply('color')(p, v || '#ffffff')} />
        <div className="ve-insp-row">
          <span className="ve-insp-label">Style</span>
          <div className="ve-insp-btns">
            <button className={`ve-insp-icon big ${st.bold ? 'on' : ''}`} title="Bold" onClick={() => set('Bold', { bold: !st.bold })}>
              <Bold size={14} />
            </button>
            <button className={`ve-insp-icon big ${st.italic ? 'on' : ''}`} title="Italic" onClick={() => set('Italic', { italic: !st.italic })}>
              <Italic size={14} />
            </button>
            <span className="ve-insp-gap" />
            {(['left', 'center', 'right'] as const).map((a) => {
              const Icon = a === 'left' ? AlignLeft : a === 'center' ? AlignCenter : AlignRight;
              return (
                <button key={a} className={`ve-insp-icon big ${st.align === a ? 'on' : ''}`} title={`Align ${a === 'center' ? 'centre' : a}`} onClick={() => set('Align text', { align: a })}>
                  <Icon size={14} />
                </button>
              );
            })}
          </div>
        </div>
        {num('lineHeight', 'Line height', 0.8, 3, 0.05, '', 2)}
      </Section>
      <Section title="Background box">
        <ColourInput label="Colour" value={st.box} undo="Change box colour" allowNone apply={apply('box')} />
        {st.box && (
          <>
            {num('boxOpacity', 'Opacity', 0, 100, 1, '%')}
            {num('boxPadding', 'Padding', 0, 200, 1, 'px')}
            {num('boxRadius', 'Corners', 0, 200, 1, 'px')}
          </>
        )}
      </Section>
      <Section title="Outline and shadow">
        <ColourInput label="Outline" value={st.outline} undo="Change outline" allowNone apply={apply('outline')} />
        {st.outline && num('outlineWidth', 'Width', 0, 40, 1, 'px')}
        <ColourInput label="Shadow" value={st.shadow} undo="Change shadow" allowNone apply={apply('shadow')} />
        {st.shadow && (
          <>
            {num('shadowBlur', 'Blur', 0, 80, 1, 'px')}
            {num('shadowY', 'Drop', -40, 40, 1, 'px')}
          </>
        )}
      </Section>
      <Section title="Animation">
        <Select<TextAnim> label="In" value={st.animIn} options={TEXT_ANIMS} onChange={(v) => set('Change animation', { animIn: v })} />
        <Select<TextAnim> label="Out" value={st.animOut} options={TEXT_ANIMS.filter((a) => a.id !== 'typewriter')} onChange={(v) => set('Change animation', { animOut: v })} />
        {num('animDuration', 'Length', 0.1, 3, 0.05, 's', 2)}
      </Section>
    </>
  );
}

function ShapeTab({ clip }: { clip: Clip }) {
  const store = useVEStore();
  const sh = clip.shape!;
  const apply =
    <K extends keyof ShapeStyle>(k: K) =>
    (p: Project, v: ShapeStyle[K]) => {
      const c = find(p, clip.id);
      if (c?.shape) c.shape[k] = v;
    };
  const num = (k: 'w' | 'h' | 'radius' | 'strokeWidth', label: string, max: number) => (
    <Slider label={label} undo={`Change ${label.toLowerCase()}`} value={sh[k]} min={k === 'w' || k === 'h' ? 1 : 0} max={max} unit="px" free apply={apply(k)} />
  );
  return (
    <Section title="Shape">
      <Select<ShapeKind>
        label="Kind"
        value={sh.shape}
        options={[
          { id: 'matte', label: 'Colour matte (full frame)' },
          { id: 'rect', label: 'Rectangle' },
          { id: 'ellipse', label: 'Ellipse' }
        ]}
        onChange={(v) =>
          store.getState().commit('Change shape', (p) => {
            const c = find(p, clip.id);
            if (c?.shape) c.shape.shape = v;
          })
        }
      />
      <ColourInput label="Fill" value={sh.fill} undo="Change fill" allowNone apply={apply('fill')} />
      {sh.shape !== 'matte' && (
        <>
          {num('w', 'Width', 4000)}
          {num('h', 'Height', 4000)}
          {sh.shape === 'rect' && num('radius', 'Corners', 1000)}
          <ColourInput label="Outline" value={sh.stroke} undo="Change outline" allowNone apply={apply('stroke')} />
          {sh.stroke && num('strokeWidth', 'Outline width', 100)}
        </>
      )}
    </Section>
  );
}

function AudioTab({ clip, player, linked }: { clip: Clip; player: Player; linked: boolean }) {
  const store = useVEStore();
  const project = useVE((s) => s.project);
  const [busy, setBusy] = useState(false);
  const media = mediaOf(project, clip);
  const prop =
    (k: 'gain' | 'fadeIn' | 'fadeOut' | 'pan') =>
    (p: Project, v: number) => {
      const c = find(p, clip.id);
      if (c) c.props[k] = v;
    };
  const normalize = async () => {
    if (!media) return;
    setBusy(true);
    try {
      const peaks = await peaksFor(media);
      if (!peaks) return toast("Couldn't read this clip's sound", 'error');
      const a = Math.max(0, Math.floor(Math.min(clip.in, clip.out) * peaks.rate));
      const b = Math.min(peaks.data.length, Math.ceil(Math.max(clip.in, clip.out) * peaks.rate) + 1);
      let peak = 0;
      for (let i = a; i < b; i++) if (peaks.data[i] > peak) peak = peaks.data[i];
      if (peak <= EPS) return toast('This clip is silent');
      const gain = clamp(-1 - 20 * Math.log10(peak), -30, 30);
      store.getState().commit('Normalize', (p) => {
        const c = find(p, clip.id);
        if (c) c.props.gain = Math.round(gain * 10) / 10;
      });
      toast(`Gain set to ${gain >= 0 ? '+' : ''}${gain.toFixed(1)} dB (loudest peak at -1 dB)`, 'success');
    } finally {
      setBusy(false);
    }
  };
  const len = clipDuration(clip);
  return (
    <>
      {linked && <div className="ve-insp-note pad">Editing the linked sound clip.</div>}
      <Section
        title="Level"
        onReset={() =>
          store.getState().commit('Reset level', (p) => {
            const c = find(p, clip.id);
            if (!c) return;
            delete c.kf.volume;
            c.props.volume = 0;
            c.props.gain = 0;
            c.props.pan = 0;
          })
        }
      >
        <AnimSlider clip={clip} prop="volume" label="Volume" min={-60} max={12} step={0.5} digits={1} unit="dB" player={player} />
        <Slider label="Gain" undo="Change gain" value={clip.props.gain} min={-30} max={30} step={0.5} digits={1} unit="dB" apply={prop('gain')} title="Extra boost or cut before the volume" />
        <Slider label="Pan" undo="Change pan" value={clip.props.pan} min={-100} max={100} title="Left (−) or right (+)" apply={prop('pan')} />
        <button className="btn tonal sm ve-insp-wide" disabled={busy || !media} title="Set the gain so the loudest moment peaks at -1 dB" onClick={normalize}>
          <Volume2 size={14} /> {busy ? 'Measuring…' : 'Normalize'}
        </button>
      </Section>
      <Section title="Fades">
        <Slider label="Fade in" undo="Change fade in" value={clip.props.fadeIn} min={0} max={Math.max(0.1, len / 2)} step={0.05} digits={2} unit="s" apply={prop('fadeIn')} />
        <Slider label="Fade out" undo="Change fade out" value={clip.props.fadeOut} min={0} max={Math.max(0.1, len / 2)} step={0.05} digits={2} unit="s" apply={prop('fadeOut')} />
      </Section>
    </>
  );
}
