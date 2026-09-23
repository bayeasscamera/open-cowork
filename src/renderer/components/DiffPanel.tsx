import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buildDiffView, diffLineAnchor, type DiffLine } from '../../shared/diff-view';
import { useAppStore } from '../store';

interface DiffFile {
  path: string;
  added: number;
  removed: number;
  updatedAt: number;
  before: string | null;
  after: string | null;
  diff: string;
}

const POLL_MS = 3000;

const LINE_STYLE: Record<DiffLine['kind'], string> = {
  context: 'text-text-secondary',
  added: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  removed: 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
};

const LINE_SIGN: Record<DiffLine['kind'], string> = {
  context: ' ',
  added: '+',
  removed: '−',
};

/**
 * One rendered diff line: the two gutters, the sign and the text. A line that
 * exists in the new file is a button that opens the file at that line.
 */
function DiffLineRow({
  line,
  label,
  onOpen,
}: {
  line: DiffLine;
  label: string;
  onOpen: (line: number) => void;
}) {
  const text = line.text === '' ? ' ' : line.text;
  return (
    <div
      className={'flex items-start font-mono text-[11px] leading-5 ' + LINE_STYLE[line.kind]}
      data-kind={line.kind}
    >
      <span className="w-9 shrink-0 select-none px-1 text-right text-text-muted">
        {line.oldLine ?? ''}
      </span>
      <span className="w-9 shrink-0 select-none px-1 text-right text-text-muted">
        {line.newLine ?? ''}
      </span>
      <span className="w-4 shrink-0 select-none text-center opacity-70">{LINE_SIGN[line.kind]}</span>
      {line.newLine === null ? (
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-all">{text}</span>
      ) : (
        <button
          type="button"
          onClick={() => onOpen(diffLineAnchor(line))}
          title={label}
          aria-label={label}
          className="min-w-0 flex-1 whitespace-pre-wrap break-all text-left hover:underline"
        >
          {text}
        </button>
      )}
    </div>
  );
}

/**
 * Live diff sidebar: session file changes with per-file line counters and an
 * integrated, line-numbered diff built from the recorded before/after pair
 * (shared pure module, so the algorithm is unit tested). Data comes from the
 * diff-panel local mod via the diff.getSessionFiles IPC channel; refresh is a
 * poll while the panel is visible. Clicking a line opens the file at it.
 */
export function DiffPanel() {
  const { t } = useTranslation();
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const [files, setFiles] = useState<DiffFile[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    if (!activeSessionId) return;
    const id = ++requestId.current;
    setError(false);
    try {
      const result = await window.electronAPI.diff.getSessionFiles(activeSessionId);
      if (id !== requestId.current) return;
      if (!result.success) {
        setError(true);
        return;
      }
      setFiles(result.files);
      setSelected((prev) =>
        prev && result.files.some((file) => file.path === prev) ? prev : result.files[0]?.path ?? null
      );
    } catch {
      if (id === requestId.current) setError(true);
    }
  }, [activeSessionId]);

  useEffect(() => {
    setFiles([]);
    setSelected(null);
    setOpenFailed(false);
    requestId.current += 1;
    if (!activeSessionId) return;
    void load();
    const timer = setInterval(() => {
      void load();
    }, POLL_MS);
    return () => {
      clearInterval(timer);
      requestId.current += 1;
    };
  }, [activeSessionId, load]);

  const entry = files.find((file) => file.path === selected) ?? null;
  const view = useMemo(
    () => (entry ? buildDiffView(entry.before, entry.after) : null),
    [entry]
  );

  const openAt = useCallback(
    async (filePath: string, line?: number) => {
      if (!activeSessionId) return;
      setOpenFailed(false);
      try {
        const result = await window.electronAPI.controlCenter.openInEditor(
          activeSessionId,
          filePath,
          line
        );
        if (!result?.success) setOpenFailed(true);
      } catch {
        setOpenFailed(true);
      }
    },
    [activeSessionId]
  );

  return (
    <aside
      className="flex h-full w-full flex-col border-l border-border bg-background-secondary/40"
      aria-label={t('diffPanel.title')}
    >
      <div className="border-b border-border-muted px-4 py-3">
        <h3 className="text-sm font-semibold text-text-primary">{t('diffPanel.title')}</h3>
        <p className="mt-0.5 text-xs text-text-muted">{t('diffPanel.description')}</p>
      </div>
      {error && (
        <p role="alert" className="px-4 py-2 text-xs text-rose-500">
          {t('diffPanel.error')}
        </p>
      )}
      {openFailed && (
        <p role="alert" className="px-4 py-2 text-xs text-rose-500">
          {t('diffPanel.openFailed')}
        </p>
      )}
      {!error && files.length === 0 && (
        <p className="px-4 py-2 text-xs text-text-muted">{t('diffPanel.empty')}</p>
      )}
      {files.length > 0 && (
        <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,200px)_minmax(0,1fr)]">
          <div
            role="list"
            aria-label={t('diffPanel.files')}
            className="overflow-auto border-b border-border-muted"
          >
            {files.map((file) => (
              <button
                key={file.path}
                role="listitem"
                aria-pressed={selected === file.path}
                onClick={() => setSelected(file.path)}
                className={'block w-full break-all px-4 py-2 text-left text-xs ' +
                  (selected === file.path
                    ? 'bg-accent/5 text-text-primary'
                    : 'text-text-secondary hover:bg-surface-hover')}
              >
                <span className="block break-all">{file.path}</span>
                <span className="mt-0.5 block font-mono">
                  <span className="text-emerald-500">+{file.added}</span>{' '}
                  <span className="text-rose-500">−{file.removed}</span>
                </span>
              </button>
            ))}
          </div>
          {entry && (
            <div className="flex min-h-0 flex-col">
              <div className="flex items-center justify-between gap-2 border-b border-border-muted px-3 py-1.5">
                <span className="min-w-0 flex-1 break-all text-[11px] text-text-muted">
                  {entry.path}
                </span>
                <button
                  type="button"
                  onClick={() => void openAt(entry.path)}
                  className="shrink-0 rounded border border-border px-2 py-0.5 text-[11px] text-text-secondary hover:bg-surface-hover"
                >
                  {t('diffPanel.openFile')}
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                {view && view.truncated && (
                  <p className="px-3 py-2 text-[11px] text-amber-500">{t('diffPanel.truncated')}</p>
                )}
                {view && view.hunks.length === 0 && (
                  <p className="px-3 py-2 text-xs text-text-muted">{t('diffPanel.unchanged')}</p>
                )}
                {view &&
                  view.hunks.map((hunk) => (
                    <div key={hunk.header} className="border-b border-border-muted/50">
                      <div className="bg-background-tertiary/60 px-3 py-1 font-mono text-[11px] text-text-muted">
                        {hunk.header}
                      </div>
                      {hunk.lines.map((line, index) => (
                        <DiffLineRow
                          key={hunk.header + ':' + index}
                          line={line}
                          label={t('diffPanel.openAtLine', { line: diffLineAnchor(line) })}
                          onOpen={(target) => void openAt(entry.path, target)}
                        />
                      ))}
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
