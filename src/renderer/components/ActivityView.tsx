import { useTranslation } from 'react-i18next';
import { useSubagentStates } from '../hooks/useSubagentProgress';
import { ActivityFeed } from './ActivityFeed';
import { SubagentProgress } from './SubagentProgress';

/**
 * Cowork 4.0 — the single activity view.
 *
 * Tool calls and delegated sub-agents used to live in two unrelated places: the
 * Control Center showed tool activity, while sub-agent cards were rendered
 * inline in the chat stream with no shared context. This view merges both, so
 * "what is the agent doing right now" has exactly one answer.
 */
export function ActivityView({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const subagents = useSubagentStates(sessionId);
  const running = subagents.filter((state) => state.status === 'running').length;

  return (
    <div className="flex flex-col gap-4">
      {subagents.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-text-secondary">
              {t('controlCenter.activity.subagents', { count: subagents.length })}
            </span>
            {running > 0 && (
              <span className="text-[10px] text-amber-400">
                {t('controlCenter.activity.running', { count: running })}
              </span>
            )}
          </div>
          {subagents.map((state) => (
            <SubagentProgress key={state.subagentId} state={state} />
          ))}
        </section>
      )}

      <section className="space-y-2">
        <span className="text-xs font-medium text-text-secondary">
          {t('controlCenter.activity.tools')}
        </span>
        <ActivityFeed sessionId={sessionId} />
      </section>
    </div>
  );
}
