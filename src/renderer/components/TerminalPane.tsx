import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Square, Trash2 } from 'lucide-react';
import type { TerminalChunk, TerminalSessionInfo } from '../../shared/control-center-types';

const POLL_MS = 1000;
/** Lines kept in the view; the main process already bounds its own buffer. */
const MAX_LINES = 400;

/**
 * Cowork 4.0 — Phase 6: the embedded terminal of the control center. Commands
 * run in a piped shell (no TTY), rooted at the session workspace; the pane
 * polls for new output by sequence number instead of re-reading everything.
 */
export function TerminalPane({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const api = typeof window !== 'undefined' ? window.electronAPI?.controlCenter : undefined;
  const [sessions, setSessions] = useState<TerminalSessionInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [active, setActive] = useState<TerminalSessionInfo | null>(null);
  const [lines, setLines] = useState<TerminalChunk[]>([]);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const cursor = useRef(0);
  const outputRef = useRef<HTMLDivElement | null>(null);

  const loadSessions = useCallback(async () => {
    if (!api) {
      return;
    }
    try {
      const next = await api.terminalList(sessionId);
      setSessions(next);
      setError(null);
      setActiveId((current) => current ?? next[0]?.id ?? null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [api, sessionId]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    if (!api || !activeId) {
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const snapshot = await api.terminalSnapshot(sessionId, activeId, cursor.current);
        if (cancelled) {
          return;
        }
        if (snapshot.output.length > 0) {
          cursor.current = snapshot.output[snapshot.output.length - 1].seq;
          setLines((current) => [...current, ...snapshot.output].slice(-MAX_LINES));
        }
        setActive(snapshot.session);
        setError(null);
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    };
    void poll();
    const timer = setInterval(() => {
      void poll();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [api, sessionId, activeId]);

  useEffect(() => {
    const node = outputRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
  }, [lines]);

  const open = useCallback(async () => {
    if (!api) {
      return;
    }
    try {
      const snapshot = await api.terminalOpen(sessionId);
      cursor.current = snapshot.output[snapshot.output.length - 1]?.seq ?? 0;
      setLines(snapshot.output);
      setActive(snapshot.session);
      setActiveId(snapshot.session.id);
      setError(null);
      await loadSessions();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [api, loadSessions, sessionId]);

  const submit = useCallback(async () => {
    if (!api || !activeId || input.trim().length === 0) {
      return;
    }
    try {
      await api.terminalWrite(sessionId, activeId, input);
      setInput('');
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [activeId, api, input, sessionId]);

  const clear = useCallback(async () => {
    if (!api || !activeId) {
      return;
    }
    try {
      await api.terminalClear(sessionId, activeId);
      setLines([]);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [activeId, api, sessionId]);

  const close = useCallback(async () => {
    if (!api || !activeId) {
      return;
    }
    try {
      await api.terminalClose(sessionId, activeId);
      cursor.current = 0;
      setLines([]);
      setActive(null);
      setActiveId(null);
      await loadSessions();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [activeId, api, loadSessions, sessionId]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={!api}
          onClick={() => void open()}
          className="flex items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-xs text-text-secondary disabled:opacity-40"
        >
          <Plus className="h-3.5 w-3.5" />
          {t('controlCenter.terminal.open')}
        </button>
        {sessions.length > 0 && (
          <select
            value={activeId ?? ''}
            onChange={(event) => {
              cursor.current = 0;
              setLines([]);
              setActiveId(event.target.value || null);
            }}
            className="rounded-lg border border-border bg-background px-2 py-1 text-xs text-text-primary"
          >
            {sessions.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.shell} — {candidate.cwd}
              </option>
            ))}
          </select>
        )}
        {activeId && (
          <>
            <button
              type="button"
              onClick={() => void clear()}
              aria-label={t('controlCenter.terminal.clear')}
              className="rounded-lg border border-border px-2 py-1 text-xs text-text-secondary"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => void close()}
              aria-label={t('controlCenter.terminal.close')}
              className="rounded-lg border border-border px-2 py-1 text-xs text-text-secondary"
            >
              <Square className="h-3.5 w-3.5" />
            </button>
          </>
        )}
        {active && (
          <span className="text-[11px] text-text-muted">
            {active.running
              ? t('controlCenter.terminal.running')
              : t('controlCenter.terminal.exited', { code: active.exitCode ?? 0 })}
          </span>
        )}
      </div>

      <p className="text-[11px] text-text-muted">{t('controlCenter.terminal.hint')}</p>

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-400">
          {error}
        </div>
      )}

      {!activeId ? (
        <p className="text-xs text-text-muted">{t('controlCenter.terminal.noTerminal')}</p>
      ) : (
        <>
          <div
            ref={outputRef}
            className="h-72 overflow-y-auto rounded-lg border border-border-subtle bg-black/40 px-3 py-2 font-mono text-[11px] leading-relaxed"
          >
            {lines.length === 0 ? (
              <p className="text-text-muted">{t('controlCenter.terminal.empty')}</p>
            ) : (
              lines.map((chunk) => (
                <span
                  key={chunk.seq}
                  className={chunk.stream === 'stderr' ? 'block text-red-400' : 'block text-text-secondary'}
                >
                  {chunk.text}
                </span>
              ))
            )}
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
            className="flex items-center gap-2"
          >
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={t('controlCenter.terminal.placeholder')}
              className="flex-1 rounded-lg border border-border bg-background px-2 py-1 font-mono text-xs text-text-primary outline-none focus:border-accent"
            />
            <button
              type="submit"
              disabled={!api || input.trim().length === 0}
              className="rounded-lg border border-accent bg-accent/10 px-3 py-1 text-xs text-text-primary disabled:opacity-40"
            >
              {t('controlCenter.terminal.send')}
            </button>
          </form>
        </>
      )}
    </div>
  );
}
