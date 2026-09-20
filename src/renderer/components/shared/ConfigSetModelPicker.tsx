import { useTranslation } from 'react-i18next';

/**
 * Shared two-level ConfigSet → model picker.
 *
 * Single source of truth for BOTH consumers (SettingsSubAgents per-role and
 * global sub-agent selection, and the ProjectsPanel model profile selector) —
 * the exact same component, so the two screens can never drift apart.
 *
 * Value semantics (identical to subAgents.perRole): `modelId: undefined` means
 * "use the selected ConfigSet's active model"; picking the active model in the
 * list normalizes back to undefined so nothing redundant is persisted.
 */

export interface ConfigSetLite {
  id: string;
  name: string;
  /** The set's currently active model. */
  activeModel: string;
  /** Every model configured in the set (active + customModels), deduplicated. */
  models: string[];
}

export interface ConfigSetModelSelection {
  configSetId: string;
  /** Model pinned inside the selected set (undefined = its active model). */
  modelId?: string;
}

/** Extract the picker-facing view of the persisted configSets. */
export function buildConfigSetLites(config: {
  configSets?: Array<{
    id: string;
    name: string;
    activeProfileKey?: string;
    profiles?: Record<string, { model?: string; customModels?: string[] }>;
  }>;
}): ConfigSetLite[] {
  return (
    config.configSets?.map((s) => {
      const profile =
        (s.activeProfileKey && s.profiles?.[s.activeProfileKey]) ||
        Object.values(s.profiles ?? {})[0];
      const models = [
        ...new Set(
          [profile?.model, ...(profile?.customModels ?? [])].filter(
            (m): m is string => typeof m === 'string' && m.trim().length > 0
          )
        ),
      ];
      return { id: s.id, name: s.name, activeModel: profile?.model ?? '', models };
    }) ?? []
  );
}

interface ConfigSetModelPickerProps {
  sets: ConfigSetLite[];
  value: ConfigSetModelSelection;
  onChange: (next: ConfigSetModelSelection) => void;
  disabled?: boolean;
  /** Literal (already-translated) label for the ConfigSet row. */
  configSetLabel: string;
  /** Literal (already-translated) label for the model row. */
  modelLabel: string;
  /** Renders an empty option ("no set") as the first choice. */
  allowEmpty?: boolean;
  emptyLabel?: string;
  inputClassName?: string;
}

export function ConfigSetModelPicker({
  sets,
  value,
  onChange,
  disabled,
  configSetLabel,
  modelLabel,
  allowEmpty,
  emptyLabel,
  inputClassName = 'rounded-lg border border-border bg-background px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none',
}: ConfigSetModelPickerProps) {
  const { t } = useTranslation();
  const chosen = sets.find((set) => set.id === value.configSetId);

  return (
    <>
      <label className="flex items-center gap-2 text-sm text-text-secondary">
        <span className="w-24 text-xs text-text-muted">{configSetLabel}</span>
        <select
          className={`${inputClassName} flex-1`}
          disabled={disabled}
          value={value.configSetId}
          aria-label={configSetLabel}
          onChange={(e) => onChange({ configSetId: e.target.value, modelId: undefined })}
        >
          {allowEmpty && <option value="">{emptyLabel}</option>}
          {sets.map((set) => (
            <option key={set.id} value={set.id}>
              {set.name}
            </option>
          ))}
        </select>
      </label>
      {chosen && chosen.models.length > 0 && (
        <label className="flex items-center gap-2 text-sm text-text-secondary">
          <span className="w-24 text-xs text-text-muted">{modelLabel}</span>
          <select
            className={`${inputClassName} flex-1`}
            disabled={disabled}
            value={value.modelId ?? chosen.activeModel}
            aria-label={modelLabel}
            onChange={(e) =>
              onChange({
                configSetId: value.configSetId,
                modelId: e.target.value === chosen.activeModel ? undefined : e.target.value,
              })
            }
          >
            {chosen.models.map((model) => (
              <option key={model} value={model}>
                {model === chosen.activeModel ? `${model} (${t('subAgents.activeModel')})` : model}
              </option>
            ))}
          </select>
        </label>
      )}
    </>
  );
}