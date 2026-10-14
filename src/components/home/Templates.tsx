import { X, GraduationCap, Briefcase, Heart, FileText } from 'lucide-react';
import { TEMPLATES, templateBytes, Template } from '../../editors/doc/templates';
import { useTabs } from '../../store';
import { setting, openSettings } from '../../lib/settings';

const GROUP_ICON = { School: GraduationCap, Work: Briefcase, Personal: Heart } as const;

export function openTemplate(t: Template) {
  const { name, data } = templateBytes(t);
  useTabs.getState().addTab({ kind: 'doc', name, path: null, data });
}

/** Gallery of ready-made documents. */
export function TemplateGallery({ onClose }: { onClose(): void }) {
  const groups = ['School', 'Work', 'Personal'] as const;
  const named = !!(setting<string>('user.name') || '').trim();
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog tpl-dialog">
        <div className="ai-settings-head">
          <h2>Templates</h2>
          <button className="icon-btn sm" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        {!named && (
          <p className="tpl-tip">
            Tip: add your name in{' '}
            <button className="link-btn" onClick={() => (onClose(), openSettings('general'))}>
              Settings → General
            </button>{' '}
            and templates fill it in (like the MLA header).
          </p>
        )}
        <div className="tpl-scroll">
          {groups.map((g) => {
            const Icon = GROUP_ICON[g];
            return (
              <section key={g}>
                <div className="tpl-group">
                  <Icon size={15} /> {g}
                </div>
                <div className="tpl-grid">
                  {TEMPLATES.filter((t) => t.group === g).map((t) => (
                    <button key={t.id} className="tpl-card" onClick={() => (openTemplate(t), onClose())}>
                      <div className={`tpl-thumb tpl-${t.id}`}>
                        <FileText size={26} />
                        <span className="tpl-lines">
                          <i />
                          <i />
                          <i />
                          <i />
                        </span>
                      </div>
                      <div className="tpl-name">{t.name}</div>
                      <div className="tpl-blurb">{t.blurb}</div>
                    </button>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
