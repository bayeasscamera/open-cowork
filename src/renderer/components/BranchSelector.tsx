import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, GitBranch, Plus, Search, Loader2 } from 'lucide-react';
import { useAppStore } from '../store';

interface BranchEntry {
  name: string;
  current: boolean;
}

interface BranchesPayload {
  isRepo: boolean;
  branches: BranchEntry[];
  currentBranch: string | null;
  dirtyCount: number;
  repoRoot: string | null;
  error?: string;
}

const EMPTY: BranchesPayload = {
  isRepo: false,
  branches: [],
  currentBranch: null,
  dirtyCount: 0,
  repoRoot: null,
};

/** Which way to carry uncommitted work across a branch switch. */
type PendingChoice = { branch: string; dirtyCount: number };

/**
 * Branch selector popover, anchored under its dock button.
 *
 * The branch list and the uncommitted-file count are re-read every time the
 * panel opens rather than cached: switching branches is exactly the moment a
 * stale count would be most misleading.
 */
export function BranchSelector() {
  const { t } = useTranslation();
  const workingDir = useAppStore((s) => s.workingDir);
  const setGlobalNotice = useAppStore((s) => s.setGlobalNotice);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [data, setData] = useState<BranchesPayload>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingChoice | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Refresh on open so the list and the dirty count are never stale.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    window.electronAPI
      ?.git?.listBranches()
      .then((payload: BranchesPayload) => {
        if (cancelled) return;
        setData(payload ?? EMPTY);
      })
      .catch(() => {
        if (cancelled) return;
        setData(EMPTY);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  // Whether the workspace is a repository, checked when the workspace changes.
  // It cannot wait until the panel opens: a disabled icon never opens, so the
  // "not a repository" state would never be discovered.
  const [isRepo, setIsRepo] = useState(true);

  useEffect(() => {
    let cancelled = false;
    if (!workingDir) {
      setIsRepo(false);
      return;
    }
    setIsRepo(true);
    window.electronAPI
      ?.git?.isRepository()
      .then((value: boolean) => {
        if (!cancelled) setIsRepo(value);
      })
      .catch(() => {
        if (!cancelled) setIsRepo(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workingDir]);

  // Focus the search field so filtering is immediate.
  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  // Close on an outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return data.branches;
    return data.branches.filter((branch) => branch.name.toLowerCase().includes(needle));
  }, [data.branches, query]);

  const switchTo = useCallback(
    async (name: string, stash: boolean) => {
      setBusy(true);
      setError(null);
      try {
        const result = await window.electronAPI?.git?.checkoutBranch(name, stash);
        if (!result?.ok) {
          // Git's own message (conflict, blocked file) shown in place; the
          // panel stays open so the user can pick another branch.
          setError(result?.error ?? t('git.switchFailed'));
          return;
        }
        setOpen(false);
        setPending(null);
        // messageKey/messageValues rather than a pre-formatted message, so the
        // toast follows the app's language instead of the language active when
        // the component was created.
        setGlobalNotice({
          id: `git-switched-${name}`,
          type: 'success',
          message: t('git.switchedTo', { branch: name }),
          messageKey: 'git.switchedTo',
          messageValues: { branch: name },
        });
      } catch {
        setError(t('git.switchFailed'));
      } finally {
        setBusy(false);
      }
    },
    [setGlobalNotice, t]
  );

  const onPickBranch = useCallback(
    (branch: BranchEntry) => {
      if (branch.current || busy) return;
      // Uncommitted work would be carried across or left behind — ask.
      if (data.dirtyCount > 0) {
        setPending({ branch: branch.name, dirtyCount: data.dirtyCount });
        return;
      }
      void switchTo(branch.name, false);
    },
    [busy, data.dirtyCount, switchTo]
  );

  const onCreate = useCallback(async () => {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.electronAPI?.git?.createBranch(name);
      if (!result?.ok) {
        setError(result?.error ?? t('git.createFailed'));
        return;
      }
      setNewName('');
      setCreating(false);
      setOpen(false);
      setGlobalNotice({
        id: `git-created-${name}`,
        type: 'success',
        message: t('git.switchedTo', { branch: name }),
        messageKey: 'git.switchedTo',
        messageValues: { branch: name },
      });
    } catch {
      setError(t('git.createFailed'));
    } finally {
      setBusy(false);
    }
  }, [busy, newName, setGlobalNotice, t]);

  // Two distinct disabled states, each with its own explanation: no workspace
  // chosen yet, and a workspace that is not a Git repository.
  const noWorkspace = !workingDir;
  const notARepo = !noWorkspace && !isRepo;
  const disabled = noWorkspace || notARepo;
  const tooltip = noWorkspace
    ? t('git.noWorkspace')
    : notARepo
      ? t('git.notARepository')
      : t('git.branches');

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        title={tooltip}
        disabled={disabled}
        className="flex items-center justify-center rounded-lg p-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40"
        style={{ color: 'var(--ev-texte-doux)' }}
        onMouseEnter={(event) => {
          if (!disabled) {
            event.currentTarget.style.background = 'var(--ev-carte-hover)';
            event.currentTarget.style.color = 'var(--ev-texte)';
          }
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.background = 'transparent';
          event.currentTarget.style.color = 'var(--ev-texte-doux)';
        }}
      >
        <GitBranch className="h-4 w-4" />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={t('git.branches')}
          className="panel-glass absolute right-0 top-full z-50 mt-2 w-72 overflow-hidden shadow-elevated"
          // The floating-surface tokens, so this panel restyles with the theme
          // without depending on a palette class per surface.
          style={{
            background: 'var(--ev-panneau)',
            borderRadius: 'var(--ev-rayon-m)',
          }}
        >
          {/* Search field: card background, no visible border, magnifier in the
              soft text tone. */}
          <div
            className="flex items-center gap-2 px-3 py-2"
            style={{ background: 'var(--ev-carte)' }}
          >
            <Search className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ev-texte-doux)' }} />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('git.searchPlaceholder')}
              className="w-full bg-transparent text-sm outline-none"
              style={{ color: 'var(--ev-texte)' }}
            />
          </div>

          <div className="max-h-72 overflow-y-auto py-1">
            {/* Section heading: small, faint, not bold. */}
            <p
              className="px-3 py-1 text-xs font-normal"
              style={{ color: 'var(--ev-texte-faible)' }}
            >
              {t('git.branchesTitle')}
            </p>

            {loading && (
              <div
                className="flex items-center gap-2 px-3 py-2 text-sm"
                style={{ color: 'var(--ev-texte-faible)' }}
              >
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t('git.loading')}
              </div>
            )}

            {!loading && filtered.length === 0 && (
              <p className="px-3 py-2 text-sm" style={{ color: 'var(--ev-texte-faible)' }}>
                {t('git.noBranches')}
              </p>
            )}

            {filtered.map((branch) => (
              <button
                key={branch.name}
                type="button"
                onClick={() => onPickBranch(branch)}
                disabled={busy}
                // No card outline per row: just a hover wash, and a slightly
                // lighter background for the active branch.
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors disabled:opacity-50"
                style={{
                  background: branch.current ? 'var(--ev-carte-hover)' : 'transparent',
                  borderRadius: 'var(--ev-rayon-m)',
                }}
                onMouseEnter={(event) => {
                  if (!branch.current) {
                    event.currentTarget.style.background = 'var(--ev-carte-hover)';
                  }
                }}
                onMouseLeave={(event) => {
                  if (!branch.current) event.currentTarget.style.background = 'transparent';
                }}
              >
                <GitBranch className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ev-texte-faible)' }} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm" style={{ color: 'var(--ev-texte)' }}>
                    {branch.name}
                  </span>
                  {branch.current && data.dirtyCount > 0 && (
                    <span className="block text-xs" style={{ color: 'var(--ev-texte-faible)' }}>
                      {t('git.uncommittedFiles', { count: data.dirtyCount })}
                    </span>
                  )}
                </span>
                {branch.current && (
                  <Check className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ev-bleu)' }} />
                )}
              </button>
            ))}
          </div>

          {error && (
            <div className="mx-3 mb-2 rounded bg-error/10 px-2 py-1.5 text-xs text-error">
              {error}
            </div>
          )}

          <div className="h-px" style={{ background: 'var(--ev-filet)' }} />

          <div className="py-1">
            {creating ? (
              <div className="flex items-center gap-2 px-3 py-1.5">
                <input
                  autoFocus
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void onCreate();
                    if (event.key === 'Escape') setCreating(false);
                  }}
                  placeholder={t('git.newBranchPlaceholder')}
                  className="min-w-0 flex-1 rounded px-2 py-1 text-sm outline-none"
                  style={{
                    background: 'var(--ev-carte)',
                    color: 'var(--ev-texte)',
                    borderRadius: 'var(--ev-rayon-m)',
                  }}
                />
                <button
                  type="button"
                  onClick={() => void onCreate()}
                  disabled={!newName.trim() || busy}
                  className="text-xs disabled:opacity-40"
                  style={{ color: 'var(--ev-bleu)' }}
                >
                  {t('git.create')}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setCreating(true)}
                disabled={busy}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors disabled:opacity-50"
                style={{ color: 'var(--ev-texte-doux)', borderRadius: 'var(--ev-rayon-m)' }}
                onMouseEnter={(event) => {
                  event.currentTarget.style.background = 'var(--ev-carte-hover)';
                }}
                onMouseLeave={(event) => {
                  event.currentTarget.style.background = 'transparent';
                }}
              >
                <Plus className="h-3.5 w-3.5" />
                {t('git.createAndSwitch')}
              </button>
            )}
            {/* No commit-history view exists yet; the entry is present and
                disabled rather than hidden, so the affordance is discoverable. */}
            <button
              type="button"
              disabled
              title={t('git.gitGraphSoon')}
              className="flex w-full cursor-not-allowed items-center gap-2 px-3 py-1.5 text-left text-sm opacity-50"
              style={{ color: 'var(--ev-texte-faible)' }}
            >
              <GitBranch className="h-3.5 w-3.5" />
              {t('git.gitGraph')}
            </button>
          </div>

          {pending && (
            <div
              className="border-t px-3 py-2"
              style={{ borderColor: 'var(--ev-filet)', background: 'var(--ev-carte)' }}
            >
              <p className="text-xs" style={{ color: 'var(--ev-texte-doux)' }}>
                {t('git.uncommittedPrompt', {
                  branch: data.currentBranch ?? '',
                  count: pending.dirtyCount,
                })}
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => void switchTo(pending.branch, true)}
                  disabled={busy}
                  className="rounded px-2 py-1 text-xs text-white disabled:opacity-50"
                  style={{ background: 'var(--ev-bleu)', borderRadius: 'var(--ev-rayon-m)' }}
                >
                  {t('git.stashAndSwitch')}
                </button>
                <button
                  type="button"
                  onClick={() => void switchTo(pending.branch, false)}
                  disabled={busy}
                  className="rounded px-2 py-1 text-xs disabled:opacity-50"
                  style={{
                    background: 'var(--ev-panneau)',
                    color: 'var(--ev-texte-doux)',
                    borderRadius: 'var(--ev-rayon-m)',
                  }}
                >
                  {t('git.leaveHere')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
