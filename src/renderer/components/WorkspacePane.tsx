import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { File, Folder, Play, RefreshCw } from 'lucide-react';
import type {
  GitStatusSummary,
  TestCommandId,
  TestRunResult,
  WorkspaceEntry,
} from '../../shared/control-center-types';

const TEST_BUTTONS: TestCommandId[] = ['npm-test', 'npm-typecheck', 'npm-lint', 'vitest'];

function TreeNodes({
  entries,
  selected,
  onSelect,
  depth,
}: {
  entries: WorkspaceEntry[];
  selected: string | null;
  onSelect: (entry: WorkspaceEntry) => void;
  depth: number;
}) {
  return (
    <ul className={depth === 0 ? 'space-y-0.5' : 'ml-3 space-y-0.5'}>
      {entries.map((entry) => (
        <li key={entry.path}>
          <button
            type="button"
            onClick={() => onSelect(entry)}
            className={
              'flex w-full items-center gap-1.5 truncate rounded px-1.5 py-0.5 text-left text-xs ' +
              (selected === entry.path
                ? 'bg-accent/10 text-text-primary'
                : 'text-text-secondary hover:bg-surface-hover')
            }
          >
            {entry.kind === 'directory' ? (
              <Folder className="h-3 w-3 shrink-0 text-text-muted" />
            ) : (
              <File className="h-3 w-3 shrink-0 text-text-muted" />
            )}
            <span className="truncate">{entry.name}</span>
          </button>
          {entry.kind === 'directory' && entry.children && entry.children.length > 0 && (
            <TreeNodes entries={entry.children} selected={selected} onSelect={onSelect} depth={depth + 1} />
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Cowork 4.0 — Phase 6.2: workspace pane. File tree, structured git status and
 * the project's own checks, all read-only and contained in the workspace.
 */
export function WorkspacePane({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const api = typeof window !== 'undefined' ? window.electronAPI?.controlCenter : undefined;
  const [tree, setTree] = useState<WorkspaceEntry[]>([]);
  const [git, setGit] = useState<GitStatusSummary | null>(null);
  const [selected, setSelected] = useState<WorkspaceEntry | null>(null);
  const [preview, setPreview] = useState<string>('');
  const [test, setTest] = useState<TestRunResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!api) {
      return;
    }
    try {
      const [nextTree, nextGit] = await Promise.all([
        api.workspaceTree(sessionId, { maxDepth: 3, maxEntries: 400 }),
        api.gitStatus(sessionId),
      ]);
      setTree(nextTree);
      setGit(nextGit);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [api, sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openFile = useCallback(
    async (entry: WorkspaceEntry) => {
      setSelected(entry);
      if (!api || entry.kind !== 'file') {
        return;
      }
      try {
        const file = await api.readFile(sessionId, entry.path, 64 * 1024);
        setPreview(file.content);
        setError(null);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [api, sessionId]
  );

  const runTest = useCallback(
    async (commandId: TestCommandId) => {
      if (!api) {
        return;
      }
      setBusy(true);
      try {
        setTest(await api.runTests(sessionId, commandId));
        setError(null);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [api, sessionId]
  );

  const gitLists: Array<{ key: string; label: string; paths: string[] }> = git
    ? [
        { key: 'staged', label: t('controlCenter.workspace.staged'), paths: git.staged },
        { key: 'modified', label: t('controlCenter.workspace.modified'), paths: git.modified },
        { key: 'untracked', label: t('controlCenter.workspace.untracked'), paths: git.untracked },
        { key: 'deleted', label: t('controlCenter.workspace.deleted'), paths: git.deleted },
      ]
    : [];

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-400">
          {error}
        </div>
      )}

      <section className="space-y-1.5">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-medium text-text-secondary">
            {t('controlCenter.workspace.git')}
          </h3>
          <button
            type="button"
            onClick={() => void refresh()}
            aria-label={t('controlCenter.refresh')}
            className="rounded-lg border border-border px-2 py-1 text-xs text-text-secondary"
          >
            <RefreshCw className="h-3 w-3" />
          </button>
        </div>
        {!git || !git.available ? (
          <p className="text-xs text-text-muted">{t('controlCenter.workspace.noGit')}</p>
        ) : (
          <div className="space-y-1.5 rounded-lg border border-border-subtle bg-background/60 px-3 py-2">
            <div className="flex flex-wrap items-center gap-3 text-[11px] text-text-muted">
              <span>
                {t('controlCenter.workspace.branch')}: <span className="font-mono">{git.branch ?? t('controlCenter.none')}</span>
              </span>
              {git.ahead > 0 && <span>{t('controlCenter.workspace.ahead', { count: git.ahead })}</span>}
              {git.behind > 0 && <span>{t('controlCenter.workspace.behind', { count: git.behind })}</span>}
              {git.clean && <span>{t('controlCenter.workspace.clean')}</span>}
            </div>
            {gitLists
              .filter((list) => list.paths.length > 0)
              .map((list) => (
                <div key={list.key} className="text-[11px]">
                  <span className="text-text-muted">
                    {list.label} ({list.paths.length})
                  </span>
                  <ul className="mt-0.5 space-y-0.5">
                    {list.paths.slice(0, 20).map((filePath) => (
                      <li key={filePath} className="truncate font-mono text-text-secondary">
                        {filePath}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
          </div>
        )}
      </section>

      <section className="space-y-1.5">
        <h3 className="text-xs font-medium text-text-secondary">
          {t('controlCenter.workspace.tests')}
        </h3>
        <div className="flex flex-wrap gap-1.5">
          {TEST_BUTTONS.map((commandId) => (
            <button
              key={commandId}
              type="button"
              disabled={busy || !api}
              onClick={() => void runTest(commandId)}
              className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs text-text-secondary disabled:opacity-40"
            >
              <Play className="h-3 w-3" />
              {t('controlCenter.workspace.test.' + commandId)}
            </button>
          ))}
        </div>
        {test && (
          <div className="rounded-lg border border-border-subtle bg-background/60 px-3 py-2 text-[11px]">
            <div className="flex flex-wrap items-center gap-3">
              <span className={test.ok ? 'text-emerald-500' : 'text-red-400'}>
                {test.ok ? t('controlCenter.workspace.passed') : t('controlCenter.workspace.failed')}
              </span>
              <span className="font-mono text-text-muted">{test.command}</span>
              <span className="text-text-muted">
                {t('controlCenter.workspace.exitCode', { code: test.exitCode ?? t('controlCenter.none') })}
              </span>
              <span className="text-text-muted">
                {t('controlCenter.activity.duration', { ms: test.durationMs })}
              </span>
              {test.truncated && <span className="text-amber-400">{t('controlCenter.workspace.truncated')}</span>}
            </div>
            {(test.stdout || test.stderr) && (
              <pre className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-text-muted">
                {(test.stdout + (test.stderr ? '\n' + test.stderr : '')).slice(-4000)}
              </pre>
            )}
          </div>
        )}
      </section>

      <section className="grid min-h-0 grid-cols-2 gap-3">
        <div className="min-h-0 overflow-y-auto rounded-lg border border-border-subtle bg-background/60 p-2">
          {tree.length === 0 ? (
            <p className="text-xs text-text-muted">{t('controlCenter.workspace.empty')}</p>
          ) : (
            <TreeNodes entries={tree} selected={selected?.path ?? null} onSelect={(entry) => void openFile(entry)} depth={0} />
          )}
        </div>
        <div className="min-h-0 overflow-auto rounded-lg border border-border-subtle bg-background/60 p-2">
          {selected?.kind === 'file' && preview ? (
            <pre className="whitespace-pre-wrap font-mono text-[10px] text-text-secondary">{preview}</pre>
          ) : (
            <p className="text-xs text-text-muted">{t('controlCenter.workspace.previewEmpty')}</p>
          )}
        </div>
      </section>
    </div>
  );
}
