import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  PersonalFile,
  PersonalFileRevision,
  PersonalFileSummary,
  PersonalFilesErrorCode,
} from '../../types';
import { SettingsContentSection } from './shared';

const buttonClass =
  'rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-text-primary hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-60';

/** Virtual SQLite files only; content is rendered as text, never HTML or filesystem links. */
export function SettingsPersonalFiles() {
  const { t } = useTranslation();
  const [files, setFiles] = useState<PersonalFileSummary[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [file, setFile] = useState<PersonalFile | null>(null);
  const [history, setHistory] = useState<PersonalFileRevision[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<PersonalFilesErrorCode | null>(null);
  const [restored, setRestored] = useState(false);
  // Each request supersedes earlier reads; unmount also invalidates pending responses.
  const requestId = useRef(0);
  const mutating = useRef(false);

  const load = useCallback(async (path?: string | null) => {
    const id = ++requestId.current;
    setBusy(true);
    setError(null);
    setRestored(false);
    setFile(null);
    setHistory([]);
    try {
      const listing = await window.electronAPI.personalFiles.list();
      if (id !== requestId.current) return;
      if (!listing.success) {
        setFiles([]);
        setError(listing.error);
        return;
      }
      setFiles(listing.data);
      const nextPath =
        path ??
        listing.data.find((item) => item.path === '/profile.md')?.path ??
        listing.data[0]?.path ??
        null;
      setSelectedPath(nextPath);
      if (!nextPath) return;
      const [current, revisions] = await Promise.all([
        window.electronAPI.personalFiles.read(nextPath),
        window.electronAPI.personalFiles.history(nextPath),
      ]);
      if (id !== requestId.current) return;
      if (!current.success) setError(current.error);
      else setFile(current.data);
      if (!revisions.success) setError(revisions.error);
      else setHistory(revisions.data);
    } catch {
      if (id === requestId.current) setError('failed');
    } finally {
      if (id === requestId.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      requestId.current += 1;
    };
  }, [load]);

  const restore = async (revision: PersonalFileRevision) => {
    if (!file || busy || error || mutating.current || revision.deleted) return;
    if (
      !window.confirm(
        t('personalFiles.confirm', {
          path: file.path,
          generation: revision.generation,
          revision: revision.revision,
        })
      )
    )
      return;
    mutating.current = true;
    const id = ++requestId.current;
    setBusy(true);
    setRestored(false);
    try {
      const result = await window.electronAPI.personalFiles.restore({
        path: file.path,
        generation: revision.generation,
        revision: revision.revision,
        expectedVersion: file.version,
      });
      if (id !== requestId.current) return;
      if (!result.success) {
        setError(result.error);
        // Never reuse a stale CAS token; an explicit refresh is required.
        setFile(null);
        return;
      }
      await load(file.path);
      if (requestId.current === id + 1) setRestored(true);
    } catch {
      if (id === requestId.current) {
        setError('failed');
        setFile(null);
      }
    } finally {
      mutating.current = false;
      if (id === requestId.current) setBusy(false);
    }
  };

  return (
    <SettingsContentSection
      title={t('personalFiles.title')}
      description={t('personalFiles.description')}
    >
      <div
        className="space-y-3 rounded-xl border border-border-muted bg-background-secondary/60 p-4"
        aria-busy={busy}
      >
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-text-muted">{t('personalFiles.retention')}</p>
          <button
            className={buttonClass}
            disabled={busy}
            onClick={() => {
              void load(selectedPath);
            }}
          >
            {t('personalFiles.refresh')}
          </button>
        </div>
        {busy && (
          <p role="status" className="text-sm text-text-muted">
            {t('personalFiles.loading')}
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-rose-500">
            {t(`personalFiles.errors.${error}`)}
          </p>
        )}
        {restored && !error && (
          <p role="status" className="text-sm text-text-secondary">
            {t('personalFiles.restored')}
          </p>
        )}
        {!busy && !error && files.length === 0 && (
          <p className="text-sm text-text-muted">{t('personalFiles.empty')}</p>
        )}
        {files.length > 0 && (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,200px)_minmax(0,1fr)]">
            <div className="max-h-80 space-y-2 overflow-auto" aria-label={t('personalFiles.list')}>
              {files.map((item) => (
                <button
                  key={item.path}
                  disabled={busy}
                  aria-pressed={selectedPath === item.path}
                  onClick={() => {
                    void load(item.path);
                  }}
                  className={`${buttonClass} w-full break-all text-left ${selectedPath === item.path ? 'border-accent bg-accent/5' : ''}`}
                >
                  {item.path}
                </button>
              ))}
            </div>
            <div className="min-w-0 space-y-3">
              {selectedPath && (
                <p className="break-all text-sm font-medium text-text-primary">{selectedPath}</p>
              )}
              {file && (
                <div>
                  <h4 className="text-xs font-medium text-text-muted">
                    {t('personalFiles.current')}
                  </h4>
                  <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-background p-3 text-xs text-text-secondary">
                    {file.content || t('personalFiles.emptyContent')}
                  </pre>
                </div>
              )}
              <h4 className="text-sm font-medium text-text-primary">
                {t('personalFiles.history')}
              </h4>
              {!busy && history.length === 0 && (
                <p className="text-xs text-text-muted">{t('personalFiles.noHistory')}</p>
              )}
              <div className="max-h-96 space-y-2 overflow-auto">
                {[...history].reverse().map((revision) => (
                  <details
                    key={`${revision.generation}:${revision.revision}`}
                    className="rounded-lg border border-border-muted bg-background p-3"
                  >
                    <summary className="cursor-pointer text-xs text-text-secondary">
                      {t('personalFiles.revision', {
                        generation: revision.generation,
                        revision: revision.revision,
                      })}
                      {' · '}
                      {new Date(revision.timestamp).toLocaleString()}
                      {revision.deleted
                        ? ` · ${t('personalFiles.deleted')}`
                        : revision.version === file?.version
                          ? ` · ${t('personalFiles.current')}`
                          : ''}
                    </summary>
                    {!revision.deleted && (
                      <>
                        <pre className="my-3 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs text-text-secondary">
                          {revision.content || t('personalFiles.emptyContent')}
                        </pre>
                        <button
                          className={buttonClass}
                          disabled={busy || !!error || !file || revision.version === file.version}
                          onClick={() => {
                            void restore(revision);
                          }}
                        >
                          {t('personalFiles.restore')}
                        </button>
                      </>
                    )}
                  </details>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </SettingsContentSection>
  );
}
