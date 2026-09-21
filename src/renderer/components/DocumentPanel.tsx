import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, Loader2, Pencil, Save, X } from 'lucide-react';
import { useAppStore } from '../store';
import { MessageMarkdown } from './MessageMarkdown';

/**
 * Live document co-editing panel (Agent Zero "live doc" style, simple scope):
 * shows a workspace Markdown file rendered; the view AUTO-refreshes when the
 * agent edits the file (poll of the confined read IPC); the user can edit and
 * save back to disk (workspace-confined write), and the agent sees the new
 * content on its next turn. Concurrent edits warn — never silently clobber.
 */

const POLL_MS = 2500;

export function DocumentPanel() {
  const { t } = useTranslation();
  const visible = useAppStore((s) => s.documentPanelVisible);
  const setVisible = useAppStore((s) => s.setDocumentPanelVisible);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const sessions = useAppStore((s) => s.sessions);
  const workingDir = useAppStore((s) => s.workingDir);
  const sessionCwd =
    sessions.find((s) => s.id === activeSessionId)?.cwd ?? workingDir ?? '';

  const [docPath, setDocPath] = useState('');
  const [content, setContent] = useState('');
  const [mtimeMs, setMtimeMs] = useState<number | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const mtimeRef = useRef(mtimeMs);
  mtimeRef.current = mtimeMs;

  const readDoc = useCallback(
    async (path: string) => {
      if (!path || typeof window === 'undefined' || !window.electronAPI) return;
      try {
        const result = await window.electronAPI.document.read(sessionCwd, path);
        if (result.success && result.ok) {
          // Agent→UI sync: refresh the rendered view unless the user has
          // unsaved edits (those surface as a conflict warning instead).
          if (!editingRef.current) {
            setContent(result.content ?? '');
            setMtimeMs(result.mtimeMs);
            setError(null);
          } else if (result.mtimeMs !== undefined && result.mtimeMs > (mtimeRef.current ?? 0) + 1500) {
            setConflict(true);
            setMtimeMs(result.mtimeMs);
          }
        } else if (result.error) {
          setError(result.error);
        }
      } catch {
        // transient — next poll retries
      }
    },
    [sessionCwd]
  );

  // Poll while open: the agent's file tools update disk → panel follows.
  useEffect(() => {
    if (!visible || !docPath) return;
    setLoading(true);
    void readDoc(docPath).finally(() => setLoading(false));
    const timer = setInterval(() => void readDoc(docPath), POLL_MS);
    return () => clearInterval(timer);
  }, [visible, docPath, readDoc]);

  const handleSave = async (force = false) => {
    if (!docPath) return;
    setSaving(true);
    setError(null);
    try {
      const result = await window.electronAPI.document.write(
        sessionCwd,
        docPath,
        draftRef.current,
        { baseMtimeMs: mtimeMs, force }
      );
      if (result.success && result.status === 'written') {
        setContent(draftRef.current);
        setMtimeMs(result.mtimeMs);
        setConflict(false);
        setEditing(false);
      } else if (result.status === 'conflict') {
        setConflict(true);
        setMtimeMs(result.mtimeMs);
      } else {
        setError(result.error ?? t('documentPanel.writeError'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('documentPanel.writeError'));
    } finally {
      setSaving(false);
    }
  };

  if (!visible) return null;

  return (
    <div className="fixed bottom-16 right-4 top-16 z-40 flex w-[480px] overflow-hidden rounded-xl border border-border bg-background shadow-xl">
      <div className="flex w-full flex-col">
        <div className="flex items-center gap-2 border-b border-border-muted px-3 py-2">
          <FileText className="w-3.5 h-3.5 flex-shrink-0 text-text-muted" />
          <input
            type="text"
            value={docPath}
            onChange={(e) => setDocPath(e.target.value)}
            placeholder={t('documentPanel.pathPlaceholder')}
            className="min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-1 py-0.5 text-[12px] text-text-primary focus:border-border focus:outline-none"
          />
          {loading && <Loader2 className="h-3 w-3 animate-spin text-text-muted" />}
          {!editing && docPath && content && (
            <button
              onClick={() => {
                setDraft(content);
                setEditing(true);
                setConflict(false);
              }}
              className="flex h-6 w-6 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary"
              title={t('documentPanel.edit')}
            >
              <Pencil className="h-3 w-3" />
            </button>
          )}
          <button
            onClick={() => setVisible(false)}
            className="flex h-6 w-6 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary"
            title={t('common.close')}
          >
            <X className="h-3 w-3" />
          </button>
        </div>

        {conflict && (
          <div className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-2">
            <p className="text-[11px] leading-4 text-text-primary">
              {t('documentPanel.conflictWarning')}
            </p>
            <div className="mt-1.5 flex gap-2">
              <button
                onClick={() => {
                  setEditing(false);
                  setConflict(false);
                  void readDoc(docPath);
                }}
                className="rounded-lg border border-border px-2 py-1 text-[11px] text-text-secondary hover:bg-surface-hover"
              >
                {t('documentPanel.reloadAgentVersion')}
              </button>
              <button
                onClick={() => void handleSave(true)}
                className="rounded-lg border border-red-500/40 px-2 py-1 text-[11px] text-red-400 hover:bg-red-500/10"
              >
                {t('documentPanel.overwriteAnyway')}
              </button>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-3">
          {loading && !content ? (
            <Loader2 className="mx-auto mt-8 h-5 w-5 animate-spin text-text-muted" />
          ) : !docPath ? (
            <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
              <FileText className="h-8 w-8 text-text-muted" />
              <p className="text-[12px] text-text-muted">{t('documentPanel.openHint')}</p>
            </div>
          ) : editing ? (
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="h-full min-h-[200px] w-full resize-none rounded-lg border border-border bg-surface p-2.5 font-mono text-[12px] leading-5 text-text-primary focus:border-accent focus:outline-none"
            />
          ) : (
            <div className="prose-chat max-w-none text-[13px]">
              <MessageMarkdown normalizedText={content} />
            </div>
          )}
        </div>

        {editing && (
          <div className="flex items-center gap-2 border-t border-border-muted px-3 py-2">
            <button
              onClick={() => {
                setEditing(false);
                setDraft(content);
                setConflict(false);
              }}
              className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[12px] text-text-secondary hover:bg-surface-hover"
            >
              <X className="h-3 w-3" />
              {t('common.cancel')}
            </button>
            <button
              onClick={() => void handleSave(false)}
              disabled={saving}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-60"
            >
              {saving ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Save className="h-3 w-3" />
              )}
              {t('documentPanel.save')}
            </button>
          </div>
        )}

        {error && !editing && (
          <div className="border-t border-border-muted px-3 py-2">
            <p className="text-[11px] text-red-400">{error}</p>
          </div>
        )}
      </div>
    </div>
  );
}