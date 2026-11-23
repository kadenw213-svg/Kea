// Which Claude model answers (Kea 0.103): a small menu in the sidebar's header and on Home's Ask bar. "Auto" lets Kea
// pick per message (Haiku for quick jobs, Sonnet for ordinary ones, the chosen model for hard work: funnel.ts);
// choosing a model sends every message to it. It's the same choice as Settings → Claude → Model, kept in one place.
// On an API key Opus is the top choice (assistant.ts capModel); Fable is for people on their own Claude plan.
import { Check, ChevronDown, Sparkles } from 'lucide-react';
import { MenuButton } from '../Popover';
import { useSettings } from '../../lib/settings';
import { MODEL_CHOICES, capModel } from '../../lib/assistant';

export function ModelMenu({ compact = false }: { compact?: boolean }) {
  const funnel = useSettings((s) => s.values['assistant.funnel']) !== false;
  const raw = String(useSettings((s) => s.values['assistant.model']) || 'claude-opus-5-5');
  const onPlan = useSettings((s) => s.values['assistant.provider']) !== 'api';
  const model = capModel(raw);
  const current = MODEL_CHOICES.find((m) => m.id === model);
  const label = funnel ? 'Auto' : current?.label || 'Opus 5.5';
  const set = (v: Record<string, unknown>) => useSettings.getState().set(v);
  const choices = MODEL_CHOICES.filter((m) => onPlan || !m.planOnly);
  return (
    <MenuButton
      align="right"
      title="Which Claude model answers"
      button={(open) => (
        <button className={`model-chip ${compact ? 'compact' : ''} ${open ? 'open' : ''}`}>
          <Sparkles size={13} />
          <span>{label}</span>
          <ChevronDown size={12} className="model-caret" />
        </button>
      )}
    >
      {(close) => (
        <div className="model-menu">
          <div className="menu-title">Model</div>
          <button className={`menu-item ${funnel ? 'checked' : ''}`} onClick={() => (set({ 'assistant.funnel': true, ...(/haiku|sonnet/.test(model) ? { 'assistant.model': 'claude-opus-5-5' } : {}) }), close())}>
            <span className="menu-grow">
              Auto
              <span className="model-note">Picks per message: quick jobs on Haiku, hard work on {/haiku|sonnet/.test(model) ? 'Opus 5.5' : current?.label || 'Opus 5.5'}</span>
            </span>
            {funnel && <Check size={14} />}
          </button>
          <div className="menu-sep" />
          {choices.map((m) => {
            const on = !funnel && m.id === model;
            return (
              <button key={m.id} className={`menu-item ${on ? 'checked' : ''}`} onClick={() => (set({ 'assistant.funnel': false, 'assistant.model': m.id }), close())}>
                <span className="menu-grow">
                  {m.label}
                  <span className="model-note">{m.note}</span>
                </span>
                {on && <Check size={14} />}
              </button>
            );
          })}
          {!onPlan && <div className="model-foot">On an API key, Opus is the strongest choice. Fable is available on your own Claude plan.</div>}
        </div>
      )}
    </MenuButton>
  );
}
