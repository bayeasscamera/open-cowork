/**
 * Cowork 4.0 — Phase 4.4: "what Cowork knows about this project".
 *
 * Shows the four memory layers, their provenance and expiry, lets the user edit
 * or delete an entry, and previews the exact injection that would be sent for a
 * task.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import type { MemoryLayer, ProjectMemoryItem, ProjectMemoryOverview } from '../../shared/project-memory-types';
import { MEMORY_LAYERS } from '../../shared/project-memory-types';

interface ProjectMemoryPanelProps {
  sessionId: string;
  onClose: () => void;
}

const SOURCE_LABELS: Record<string, string> = {
  commit: 'commit',
  test: 'test',
  adr: 'adr',
  doc: 'doc',
  'user-decision': 'user',
  session: 'session',
  agent: 'agent',
};

export function ProjectMemoryPanel({ sessionId, onClose }: ProjectMemoryPanelProps) {
  const { t } = useTranslation();
  const api = typeof window !== 'undefined' ? window.electronAPI?.projectMemory : undefined;

  const [overview, setOverview] = useState<ProjectMemoryOverview | null>(null);
  const [items, setItems] = useState<ProjectMemoryItem[]>([]);
  const [layer, setLayer] = useState<MemoryLayer>('rules');
  const [draft, setDraft] = useState('');
  const [preview, setPreview] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!api) {
      return;
    }
    try {
      const [nextOverview, nextItems] = await Promise.all([
        api.overview(sessionId),
        api.list(sessionId),
      ]);
      setOverview(nextOverview);
      setItems(nextItems);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [api, sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true);
      try {
        await action();
        await refresh();
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );

  const visible = useMemo(() => items.filter((item) => item.layer === layer), [items, layer]);

  const addEntry = useCallback(() => {
    if (!api || draft.trim().length === 0) {
      return;
    }
    void run(() =>
      api.upsert(sessionId, {
        workspaceKey: '',
        layer,
        statement: draft.trim(),
        provenance: { source: 'user-decision', reference: sessionId },
        tags: [],
        confidence: 1,
      })
    ).then(() => setDraft(''));
  }, [api, draft, layer, run, sessionId]);

  const previewInjection = useCallback(() => {
    if (!api) {
      return;
    }
    void run(async () => {
      const injection = await api.preview(sessionId, draft.trim() || layer, 10);
      setPreview(injection.text);
    });
  }, [api, draft, layer, run, sessionId]);

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden bg-background">
      <header className="flex items-center justify-between border-b border-border-subtle px-6 py-4">
        <div>
          <h2 className="text-sm font-semibold text-text-primary">{t('projectMemory.title')}</h2>
          <p className="text-xs text-text-muted">{t('projectMemory.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy || !api}
            onClick={() => void run(() => api!.purgeExpired(sessionId))}
            className="rounded-lg border border-border px-2 py-1.5 text-xs text-text-secondary disabled:opacity-40"
          >
            {t('projectMemory.purge')}
          </button>
          <button
            type="button"
            onClick={() => void refresh()}
            className="rounded-lg border border-border px-2 py-1.5 text-xs text-text-secondary"
            aria-label={t('projectMemory.refresh')}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-2 py-1.5 text-xs text-text-secondary"
            aria-label={t('projectMemory.close')}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
        {error && (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-400">
            {error}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {MEMORY_LAYERS.map((candidate) => (
            <button
              key={candidate}
              type="button"
              onClick={() => setLayer(candidate)}
              className={
                'rounded-lg border px-3 py-1.5 text-xs transition-colors ' +
                (layer === candidate
                  ? 'border-accent bg-accent/10 text-text-primary'
                  : 'border-border text-text-secondary hover:bg-surface-hover')
              }
            >
              {t('projectMemory.layer.' + candidate)}
              <span className="ml-2 text-text-muted">
                {overview?.layers[candidate] ?? 0}
              </span>
            </button>
          ))}
          {overview && overview.expired > 0 && (
            <span className="self-center text-[11px] text-amber-400">
              {t('projectMemory.expired', { count: overview.expired })}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t('projectMemory.placeholder')}
            className="flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-xs text-text-primary outline-none focus:border-accent"
          />
          <button
            type="button"
            disabled={busy || !api || draft.trim().length === 0}
            onClick={addEntry}
            className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('projectMemory.add')}
          </button>
          <button
            type="button"
            disabled={busy || !api}
            onClick={previewInjection}
            className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary disabled:opacity-40"
          >
            <Eye className="h-3.5 w-3.5" />
            {t('projectMemory.preview')}
          </button>
        </div>

        {visible.length === 0 ? (
          <p className="text-xs text-text-muted">{t('projectMemory.empty')}</p>
        ) : (
          <ul className="space-y-2">
            {visible.map((item) => (
              <li
                key={item.id}
                className="rounded-xl border border-border-subtle bg-background/60 px-3 py-2"
              >
                <div className="flex items-start gap-2">
                  <p className="flex-1 text-xs text-text-primary">{item.statement}</p>
                  <button
                    type="button"
                    disabled={busy || !api}
                    onClick={() => api && void run(() => api.remove(sessionId, item.id))}
                    className="rounded border border-border p-1 text-text-muted hover:text-red-400 disabled:opacity-40"
                    aria-label={t('projectMemory.delete')}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-3 text-[10px] text-text-muted">
                  <span className="rounded border border-border px-1.5 py-0.5">
                    {SOURCE_LABELS[item.provenance.source] ?? item.provenance.source}
                  </span>
                  <span className="font-mono">{item.provenance.reference}</span>
                  {item.provenance.locator && (
                    <span className="font-mono">#{item.provenance.locator}</span>
                  )}
                  {item.tags.length > 0 && <span>{item.tags.join(', ')}</span>}
                  <span>
                    {item.expiresAt === null
                      ? t('projectMemory.noExpiry')
                      : t('projectMemory.expires', {
                          date: new Date(item.expiresAt).toLocaleDateString(),
                        })}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}

        {preview.length > 0 && (
          <section className="space-y-1">
            <span className="text-xs font-medium text-text-secondary">
              {t('projectMemory.previewTitle')}
            </span>
            <pre className="max-h-64 overflow-auto rounded-lg border border-border-subtle bg-background/60 p-3 text-[11px] text-text-muted">
              {preview}
            </pre>
          </section>
        )}
      </div>
    </div>
  );
}
