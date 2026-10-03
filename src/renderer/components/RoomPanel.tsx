/**
 * RoomPanel — the transcript of a multi-agent run, after the run.
 *
 * A swarm is ephemeral and expensive: the user sees a report and the work is
 * gone. A room is what remains — the members, what each produced, and the
 * questions they asked each other. This is where that is read.
 *
 * Reading a room and posting to it are both deliberate actions: opening one loads
 * its transcript on demand rather than with the list, and a note is attributed to
 * the user rather than to an agent role, so the record stays honest about who
 * said what.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Users,
  Trash2,
  Loader2,
  AlertTriangle,
  MessageSquare,
  Send,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import type { RoomUi, RoomDetailUi } from '../../shared/room-contract';

interface Props {
  sessionId: string | null;
  scope: 'session' | 'project';
  onScopeChange: (scope: 'session' | 'project') => void;
}

export function RoomPanel({ sessionId, scope, onScopeChange }: Props) {
  const { t } = useTranslation();
  const [rooms, setRooms] = useState<RoomUi[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [expanded, setExpanded] = useState<RoomDetailUi | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [isPosting, setIsPosting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const api = typeof window !== 'undefined' ? window.electronAPI?.rooms : undefined;

  const load = useCallback(async () => {
    if (!api || !sessionId) {
      setRooms([]);
      return;
    }
    setIsLoading(true);
    try {
      setRooms(await api.list(sessionId, scope));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('rooms.loadFailed'));
    } finally {
      setIsLoading(false);
    }
  }, [api, sessionId, scope, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setExpanded(null);
    setOpenId(null);
  }, [sessionId, scope]);

  async function toggle(roomId: string) {
    if (!api || !sessionId) return;
    if (openId === roomId) {
      setOpenId(null);
      setExpanded(null);
      return;
    }
    setOpenId(roomId);
    setExpanded(null);
    setBusyId(roomId);
    setError(null);
    try {
      // Loaded on demand: a list of rooms must not drag every transcript in.
      const detail = await api.detail(sessionId, roomId);
      if (!detail) {
        setError(t('rooms.notFound'));
        return;
      }
      setExpanded(detail);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('rooms.loadFailed'));
    } finally {
      setBusyId(null);
    }
  }

  async function post() {
    if (!api || !sessionId || !expanded || !note.trim()) return;
    setIsPosting(true);
    setError(null);
    try {
      const created = await api.postMessage(sessionId, expanded.id, note);
      if (!created) {
        setError(t('rooms.notFound'));
        return;
      }
      setNote('');
      setExpanded(await api.detail(sessionId, expanded.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('rooms.postFailed'));
    } finally {
      setIsPosting(false);
    }
  }

  async function remove(roomId: string) {
    if (!api || !sessionId) return;
    setBusyId(roomId);
    setError(null);
    try {
      const result = await api.delete(sessionId, roomId);
      if (result.success) {
        if (openId === roomId) {
          setOpenId(null);
          setExpanded(null);
        }
        await load();
        return;
      }
      setError(
        result.error === 'confirmation_denied' ? t('rooms.deleteDeclined') : t('rooms.deleteFailed')
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : t('rooms.deleteFailed'));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Users className="w-4 h-4 text-accent flex-shrink-0" />
          <h3 className="text-sm font-semibold text-text-primary truncate">{t('rooms.title')}</h3>
        </div>
        <div className="flex bg-surface-muted p-0.5 rounded-lg border border-border text-xs flex-shrink-0">
          <button
            onClick={() => onScopeChange('session')}
            className={`px-2.5 py-1 rounded-md transition-colors ${
              scope === 'session'
                ? 'bg-accent text-white font-medium shadow-sm'
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            {t('rooms.scopeSession')}
          </button>
          <button
            onClick={() => onScopeChange('project')}
            className={`px-2.5 py-1 rounded-md transition-colors ${
              scope === 'project'
                ? 'bg-accent text-white font-medium shadow-sm'
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            {t('rooms.scopeProject')}
          </button>
        </div>
      </div>

      <p className="text-xs text-text-muted">{t('rooms.desc')}</p>

      {error && (
        <div className="p-3 rounded-xl bg-error/10 border border-error/30 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-error flex-shrink-0 mt-0.5" />
          <span className="text-xs text-error">{error}</span>
        </div>
      )}

      {!sessionId ? (
        <p className="text-xs text-text-muted py-4 text-center">{t('rooms.noSession')}</p>
      ) : isLoading ? (
        <div className="flex items-center justify-center py-6">
          <Loader2 className="w-5 h-5 animate-spin text-accent" />
        </div>
      ) : rooms.length === 0 ? (
        <p className="text-xs text-text-muted py-6 text-center">{t('rooms.empty')}</p>
      ) : (
        <div className="space-y-1.5">
          {rooms.map((room) => (
            <div key={room.id} className="rounded-xl border border-border-subtle bg-surface">
              <div className="flex items-center gap-1 p-1.5">
                <button
                  onClick={() => toggle(room.id)}
                  disabled={busyId === room.id}
                  className="flex items-center gap-2 flex-1 min-w-0 text-left px-1 disabled:opacity-60"
                >
                  {busyId === room.id && openId === room.id ? (
                    <Loader2 className="w-3.5 h-3.5 text-accent animate-spin flex-shrink-0" />
                  ) : openId === room.id ? (
                    <ChevronDown className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />
                  ) : (
                    <ChevronRight className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />
                  )}
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-text-primary truncate">{room.name}</p>
                    <p className="text-[10px] text-text-muted truncate">
                      {t('rooms.updatedAt', { date: new Date(room.updatedAt).toLocaleString() })}
                    </p>
                  </div>
                </button>
                <button
                  onClick={() => remove(room.id)}
                  disabled={busyId === room.id}
                  className="p-1.5 rounded-lg text-text-muted hover:text-error transition-colors disabled:opacity-50"
                  title={t('rooms.delete')}
                  aria-label={t('rooms.delete')}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>

              {openId === room.id && expanded?.id === room.id && (
                <div className="px-3 pb-3 space-y-3 border-t border-border-subtle pt-2">
                  {expanded.goal && (
                    <p className="text-[11px] text-text-secondary italic">{expanded.goal}</p>
                  )}

                  {expanded.members.length > 0 && (
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[10px] text-text-muted">{t('rooms.members')}</span>
                      {expanded.members.map((m) => (
                        <span
                          key={m.role}
                          className="px-1.5 py-0.5 rounded bg-surface-muted border border-border text-[10px] font-mono text-text-secondary"
                        >
                          {m.role}
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="space-y-1.5 max-h-72 overflow-auto">
                    {expanded.messages.length === 0 ? (
                      <p className="text-[11px] text-text-muted">{t('rooms.noMessages')}</p>
                    ) : (
                      expanded.messages.map((m) => (
                        <div
                          key={m.id}
                          className={`rounded-lg border px-2.5 py-1.5 ${
                            m.kind === 'question'
                              ? 'border-border bg-surface-muted/40'
                              : m.kind === 'answer'
                                ? 'border-accent/30 bg-accent/5'
                                : 'border-border-subtle bg-background'
                          }`}
                        >
                          <div className="flex items-center gap-1.5 mb-0.5">
                            <MessageSquare className="w-3 h-3 text-text-muted flex-shrink-0" />
                            <span className="text-[10px] font-mono text-text-secondary">
                              {m.fromRole}
                            </span>
                            {m.kind !== 'note' && (
                              <span className="text-[10px] text-text-muted">
                                {t(`rooms.kind_${m.kind}`)}
                              </span>
                            )}
                            {m.status && m.status !== 'answered' && (
                              <span className="text-[10px] text-warning">
                                {t(`rooms.status_${m.status}`)}
                              </span>
                            )}
                            {m.modelCalls > 0 && (
                              <span className="text-[10px] text-text-muted">
                                {t('rooms.modelCalls', { count: m.modelCalls })}
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-text-primary whitespace-pre-wrap leading-relaxed">
                            {m.body}
                          </p>
                        </div>
                      ))
                    )}
                  </div>

                  <div className="flex items-center gap-1.5">
                    <input
                      type="text"
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void post();
                      }}
                      placeholder={t('rooms.notePlaceholder')}
                      aria-label={t('rooms.notePlaceholder')}
                      className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-background border border-border text-xs text-text-primary focus:border-accent focus:outline-none"
                    />
                    <button
                      onClick={post}
                      disabled={isPosting || !note.trim()}
                      className="p-1.5 rounded-lg bg-accent hover:bg-accent/90 text-white disabled:opacity-50 transition-colors"
                      title={t('rooms.post')}
                      aria-label={t('rooms.post')}
                    >
                      {isPosting ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Send className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}