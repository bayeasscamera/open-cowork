// Collapsible quarantine card for raw agent-protocol markup leaked into a
// message text block (tool_use / tool_result / turn tags emitted as plain
// text by a degraded model — see utils/raw-protocol-markup for the root
// cause). The markup is never rendered as prose: it lives here, collapsed by
// default, inside a wrapping viewer that cannot overflow the message column.
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';

interface RawProtocolNoticeProps {
  /** Raw protocol segments extracted from the message text, in order. */
  fragments: string[];
  /** Start expanded — used by tests and for deep-linking future diagnostics. */
  defaultExpanded?: boolean;
}

export const RawProtocolNotice = memo(function RawProtocolNotice({
  fragments,
  defaultExpanded = false,
}: RawProtocolNoticeProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(defaultExpanded);

  if (fragments.length === 0) return null;

  return (
    <div
      data-testid="raw-protocol-notice"
      className="rounded-2xl border border-warning/40 bg-background/40 overflow-hidden max-w-full my-2"
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-surface-hover/50 transition-colors"
      >
        <AlertTriangle className="w-3.5 h-3.5 text-warning flex-shrink-0" />
        <span className="text-xs font-medium text-warning flex-shrink-0">
          {t('messageCard.rawProtocolTitle')}
        </span>
        <span
          data-testid="raw-protocol-count"
          className="text-[11px] text-text-muted truncate flex-1 min-w-0"
        >
          {t('messageCard.rawProtocolCount', { count: fragments.length })}
        </span>
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-text-muted flex-shrink-0 ml-auto" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-text-muted flex-shrink-0 ml-auto" />
        )}
      </button>
      {expanded && (
        <div className="border-t border-warning/30 px-3 py-2 max-w-full overflow-x-auto">
          <p className="text-[11px] text-text-muted mb-1.5">
            {t('messageCard.rawProtocolHint')}
          </p>
          <pre
            data-testid="raw-protocol-fragments"
            className="text-[11px] font-mono text-text-secondary whitespace-pre-wrap break-all max-w-full m-0"
          >
            {fragments.join('\n\n')}
          </pre>
        </div>
      )}
    </div>
  );
});
