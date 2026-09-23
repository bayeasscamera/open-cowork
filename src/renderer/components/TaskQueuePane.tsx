import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bell, Check } from 'lucide-react';
import type { ApprovalNotification, DetachedTask } from '../../shared/control-center-types';

const POLL_MS = 3000;

/**
 * Cowork 4.0 — Phase 6.4: detached tasks and approval notifications. This is
 * where queued work and "the agent needs you" events surface, including after a
 * restart because the queue restores from its snapshot.
 */
export function TaskQueuePane({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const api = typeof window !== 'undefined' ? window.electronAPI?.controlCenter : undefined;
  const [tasks, setTasks] = useState<DetachedTask[]>([]);
  const [notifications, setNotifications] = useState<ApprovalNotification[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!api) {
      return;
    }
    try {
      const [nextTasks, nextNotifications] = await Promise.all([
        api.queue(sessionId),
        api.notifications(sessionId),
      ]);
      setTasks(nextTasks);
      setNotifications(nextNotifications);
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
    <div className="flex flex-col gap-4">
      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-400">
          {error}
        </div>
      )}

      <section className="space-y-1.5">
        <h3 className="text-xs font-medium text-text-secondary">{t('controlCenter.queue.title')}</h3>
        {tasks.length === 0 ? (
          <p className="text-xs text-text-muted">{t('controlCenter.queue.empty')}</p>
        ) : (
          <ul className="space-y-1.5">
            {tasks.map((task) => (
              <li
                key={task.id}
                className="rounded-lg border border-border-subtle bg-background/60 px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  <span className="flex-1 truncate text-xs text-text-primary">{task.label}</span>
                  <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-text-muted">
                    {task.kind}
                  </span>
                  <span className="text-[10px] text-text-muted">
                    {t('controlCenter.queue.status.' + task.status)}
                  </span>
                  {task.status === 'queued' && api && (
                    <button
                      type="button"
                      onClick={() => void api.updateTask(sessionId, task.id, 'running').then(refresh)}
                      className="rounded border border-border px-1.5 py-0.5 text-[10px] text-text-secondary"
                    >
                      {t('controlCenter.queue.start')}
                    </button>
                  )}
                  {(task.status === 'queued' || task.status === 'running') && api && (
                    <button
                      type="button"
                      onClick={() => void api.cancelTask(sessionId, task.id).then(refresh)}
                      className="rounded border border-border px-1.5 py-0.5 text-[10px] text-text-secondary"
                    >
                      {t('controlCenter.queue.cancel')}
                    </button>
                  )}
                </div>
                {task.progress !== undefined && task.progress > 0 && task.progress < 1 && (
                  <div className="mt-1 h-1 w-full overflow-hidden rounded bg-border-subtle">
                    <div className="h-full bg-accent" style={{ width: Math.round(task.progress * 100) + '%' }} />
                  </div>
                )}
                {task.error && <p className="mt-1 text-[10px] text-red-400">{task.error}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-1.5">
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
            <Bell className="h-3 w-3" />
            {t('controlCenter.queue.notifications')}
          </h3>
          <button
            type="button"
            disabled={!api || notifications.every((item) => item.acknowledged)}
            onClick={() => api && void api.acknowledgeAll(sessionId).then(refresh)}
            className="rounded-lg border border-border px-2 py-1 text-xs text-text-secondary disabled:opacity-40"
          >
            {t('controlCenter.queue.acknowledgeAll')}
          </button>
        </div>
        {notifications.length === 0 ? (
          <p className="text-xs text-text-muted">{t('controlCenter.queue.noNotifications')}</p>
        ) : (
          <ul className="space-y-1.5">
            {notifications.map((notification) => (
              <li
                key={notification.id}
                className={
                  'rounded-lg border px-3 py-2 ' +
                  (notification.acknowledged
                    ? 'border-border-subtle bg-background/40 opacity-60'
                    : 'border-accent/40 bg-accent/5')
                }
              >
                <div className="flex items-center gap-2">
                  <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-text-muted">
                    {t('controlCenter.queue.kind.' + notification.kind)}
                  </span>
                  <span className="flex-1 truncate text-xs text-text-primary">{notification.title}</span>
                  {!notification.acknowledged && api && (
                    <button
                      type="button"
                      onClick={() => void api.acknowledgeNotification(sessionId, notification.id).then(refresh)}
                      aria-label={t('controlCenter.queue.acknowledge')}
                      className="rounded border border-border p-1 text-text-muted hover:text-accent"
                    >
                      <Check className="h-3 w-3" />
                    </button>
                  )}
                </div>
                {notification.detail && (
                  <p className="mt-1 text-[10px] text-text-muted">{notification.detail}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
