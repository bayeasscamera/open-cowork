import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
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

/**
 * Live diff sidebar: session file changes with per-file line counters and an
 * inline before/after diff. Data comes from the diff-panel local mod via the
 * `diff.getSessionFiles` IPC channel; refresh is a poll while the panel is
 * visible (no cloud, no external service).
 */
export function DiffPanel() {
  const { t } = useTranslation();
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const [files, setFiles] = useState<DiffFile[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState(false);
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

  return (
    <aside className="flex h-full w-full flex-col border-l border-border bg-background-secondary/40" aria-label={t('diffPanel.title')}>
      <div className="border-b border-border-muted px-4 py-3">
        <h3 className="text-sm font-semibold text-text-primary">{t('diffPanel.title')}</h3>
        <p className="mt-0.5 text-xs text-text-muted">{t('diffPanel.description')}</p>
      </div>
      {error && (
        <p role="alert" className="px-4 py-2 text-xs text-rose-500">
          {t('diffPanel.error')}
        </p>
      )}
      {!error && files.length === 0 && (
        <p className="px-4 py-2 text-xs text-text-muted">{t('diffPanel.empty')}</p>
      )}
      {files.length > 0 && (
        <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,220px)_minmax(0,1fr)]">
          <div role="list" aria-label={t('diffPanel.files')} className="overflow-auto border-b border-border-muted">
            {files.map((file) => (
              <button
                key={file.path}
                role="listitem"
                aria-pressed={selected === file.path}
                onClick={() => setSelected(file.path)}
                className={`block w-full break-all px-4 py-2 text-left text-xs ${
                  selected === file.path
                    ? 'bg-accent/5 text-text-primary'
                    : 'text-text-secondary hover:bg-surface-hover'
                }`}
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
            <div className="min-h-0 overflow-auto p-3">
              <pre className="whitespace-pre-wrap break-words rounded-lg bg-background p-3 font-mono text-xs text-text-secondary">
                {entry.diff || t('diffPanel.unchanged')}
              </pre>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}