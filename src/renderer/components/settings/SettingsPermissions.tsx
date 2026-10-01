import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldAlert, Plus, Trash2 } from 'lucide-react';
import { useAppStore } from '../../store';
import type { PermissionRule } from '../../../shared/types';

/**
 * Explicit refusal rules ("/deny" settings surface).
 *
 * A deny rule is a persistent guardrail — "never run a command touching
 * .env", "never delete a file without asking" — that holds even under Full
 * Access / auto-approve. The main process evaluates deny rules before any
 * convenience bypass and hands the agent the rule's explanation so it adapts
 * instead of failing silently.
 */
export function SettingsPermissions({ isActive }: { isActive?: boolean }) {
  const { t } = useTranslation();
  const permissionRules = useAppStore((s) => s.settings.permissionRules) ?? [];
  const autoApproveAll = useAppStore((s) => s.settings.autoApproveAll) ?? false;
  const updateSettings = useAppStore((s) => s.updateSettings);

  const [tool, setTool] = useState('bash');
  const [pattern, setPattern] = useState('*.env*');

  if (isActive === false) return null;

  const denyRules = permissionRules.filter((rule) => rule.action === 'deny');

  const addRule = () => {
    const trimmedTool = tool.trim().toLowerCase();
    const trimmedPattern = pattern.trim();
    if (!trimmedTool) return;
    const next: PermissionRule[] = [
      ...permissionRules,
      trimmedPattern
        ? { tool: trimmedTool, pattern: trimmedPattern, action: 'deny' }
        : { tool: trimmedTool, action: 'deny' },
    ];
    updateSettings({ permissionRules: next });
    setPattern('');
  };

  const removeRule = (index: number) => {
    // Remove by position within the deny subset, mapped back to the full list.
    const target = denyRules[index];
    if (!target) return;
    const fullIndex = permissionRules.indexOf(target);
    if (fullIndex < 0) return;
    const next = permissionRules.filter((_, i) => i !== fullIndex);
    updateSettings({ permissionRules: next });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-2xl border border-border-muted bg-surface/60 p-6">
        <div className="mb-2 flex items-center gap-2">
          <ShieldAlert className="h-5 w-5 text-accent" />
          <h3 className="text-base font-semibold">{t('permissions.denyTitle')}</h3>
        </div>
        <p className="mb-1 text-sm text-text-muted">{t('permissions.denyDesc')}</p>
        {autoApproveAll && (
          <p className="mb-3 rounded-lg bg-accent/10 px-3 py-2 text-sm text-accent">
            {t('permissions.denyWinsOverFullAccess')}
          </p>
        )}

        {denyRules.length === 0 ? (
          <p className="py-3 text-sm text-text-muted">{t('permissions.noDenyRules')}</p>
        ) : (
          <ul className="flex flex-col gap-2 py-2">
            {denyRules.map((rule, i) => (
              <li
                key={`${rule.tool}:${rule.pattern ?? ''}:${i}`}
                className="flex items-center justify-between gap-3 rounded-lg border border-border-muted px-3 py-2"
              >
                <span className="text-sm">
                  <code className="rounded bg-surface px-1.5 py-0.5 font-mono">{rule.tool}</code>
                  {rule.pattern ? (
                    <span className="ml-2 font-mono text-text-muted">{rule.pattern}</span>
                  ) : (
                    <span className="ml-2 text-text-muted">{t('permissions.allInputs')}</span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => removeRule(i)}
                  title={t('permissions.removeRule')}
                  className="rounded-lg p-1.5 text-text-muted transition-colors hover:bg-surface hover:text-text"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <input
            value={tool}
            onChange={(e) => setTool(e.target.value)}
            placeholder={t('permissions.toolPlaceholder')}
            aria-label={t('permissions.toolPlaceholder')}
            className="w-full rounded-lg border border-border-muted bg-surface px-3 py-2 font-mono text-sm sm:w-40"
          />
          <input
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            placeholder={t('permissions.patternPlaceholder')}
            aria-label={t('permissions.patternPlaceholder')}
            className="w-full flex-1 rounded-lg border border-border-muted bg-surface px-3 py-2 font-mono text-sm"
          />
          <button
            type="button"
            onClick={addRule}
            disabled={!tool.trim()}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            {t('permissions.addRule')}
          </button>
        </div>
        <p className="mt-2 text-xs text-text-muted">{t('permissions.patternHint')}</p>
      </div>
    </div>
  );
}
