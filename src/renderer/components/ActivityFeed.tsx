import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import type { ActivityEvent, ActivityStatus } from '../../shared/control-center-types';

const POLL_MS = 2000;

const STATUS_DOT: Record<ActivityStatus, string> = {
  running: 'bg-amber-400 animate-pulse',
  ok: 'bg-emerald-500',
  error: 'bg-red-500',
  cancelled: 'bg-zinc-500',
};

/**
 * Cowork 4.0 — Phase 6.3: the live tool-activity feed. Every agent tool call is
 * shown with its status, duration and error, so a run is auditable while it
 * happens instead of only at the end.
 */
export function ActivityFeed({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const api = typeof window !== 'undefined' ? window.electronAPI?.controlCenter : undefined;
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!api) {
      return;
    }
    try {
      setEvents(await api.activity(sessionId, 100));
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [api, sessionId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-text-muted">
          {t('controlCenter.activity.count', { count: events.length })}
        </span>
        <button
          type="button"
          disabled={!api || events.length === 0}
          onClick={() => api && void api.clearActivity(sessionId).then(refresh)}
          className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs text-text-secondary disabled:opacity-40"
        >
          <Trash2 className="h-3 w-3" />
          {t('controlCenter.activity.clear')}
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-400">
          {error}
        </div>
      )}

      {events.length === 0 ? (
        <p className="text-xs text-text-muted">{t('controlCenter.activity.empty')}</p>
      ) : (
        <ul className="space-y-1.5">
          {events.map((event) => (
            <li
              key={event.id}
              className="rounded-lg border border-border-subtle bg-background/60 px-3 py-2"
            >
              <div className="flex items-center gap-2">
                <span className={'h-2 w-2 shrink-0 rounded-full ' + STATUS_DOT[event.status]} />
                <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-text-muted">
                  {event.tool}
                </span>
                <span className="flex-1 truncate text-xs text-text-primary">{event.label}</span>
                {event.durationMs !== undefined && (
                  <span className="text-[10px] text-text-muted">
                    {t('controlCenter.activity.duration', { ms: event.durationMs })}
                  </span>
                )}
                <span className="text-[10px] text-text-muted">
                  {t('controlCenter.activity.status.' + event.status)}
                </span>
              </div>
              {event.detail && (
                <p className="mt-1 truncate font-mono text-[10px] text-text-muted">{event.detail}</p>
              )}
              {event.error && <p className="mt-1 text-[10px] text-red-400">{event.error}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
