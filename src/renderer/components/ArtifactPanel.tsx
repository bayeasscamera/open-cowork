/**
 * ArtifactPanel — lists the persistent artifacts of the current session and
 * lets the user read the content, browse the version history, and delete.
 *
 * Deliberately separate from ArtifactModal, which previews a workspace file
 * from disk. An artifact is a stored record: it can outlive the file that
 * produced it, and it has versions. Reusing the file preview would have hidden
 * both.
 *
 * Deletion goes through a native confirmation in the main process, so the
 * button only reflects the outcome it gets back rather than assuming.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  FileText,
  Code,
  Eye,
  Copy,
  Check,
  Trash2,
  History,
  Loader2,
  AlertTriangle,
  X,
  Layers,
} from 'lucide-react';
import { copyTextToClipboard } from '../utils/clipboard';
import type {
  PersistentArtifact,
  PersistentArtifactContent,
  PersistentArtifactVersion,
} from '../../shared/artifact-contract';

interface Props {
  /** Session being viewed; null means nothing is selected yet. */
  sessionId: string | null;
  scope: 'session' | 'project';
  onScopeChange: (scope: 'session' | 'project') => void;
}

export function ArtifactPanel({ sessionId, scope, onScopeChange }: Props) {
  const { t } = useTranslation();
  const [artifacts, setArtifacts] = useState<PersistentArtifact[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selected, setSelected] = useState<PersistentArtifactContent | null>(null);
  const [versions, setVersions] = useState<PersistentArtifactVersion[]>([]);
  const [viewingVersion, setViewingVersion] = useState<number | null>(null);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [mode, setMode] = useState<'preview' | 'raw'>('raw');
  const [copied, setCopied] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const api = typeof window !== 'undefined' ? window.electronAPI?.artifacts?.persistent : undefined;

  const load = useCallback(async () => {
    if (!api || !sessionId) {
      setArtifacts([]);
      return;
    }
    setIsLoading(true);
    try {
      setArtifacts(await api.list(sessionId, scope));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('artifacts.loadFailed'));
    } finally {
      setIsLoading(false);
    }
  }, [api, sessionId, scope, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // A different session or scope invalidates whatever is open.
  useEffect(() => {
    setSelected(null);
    setVersions([]);
    setPreviewContent(null);
    setViewingVersion(null);
  }, [sessionId, scope]);

  async function open(artifactId: string) {
    if (!api || !sessionId) return;
    setBusyId(artifactId);
    setError(null);
    try {
      const content = await api.get(sessionId, artifactId);
      if (!content) {
        setError(t('artifacts.notFound'));
        return;
      }
      setSelected(content);
      setPreviewContent(content.content);
      setViewingVersion(content.version);
      setMode(content.kind === 'markdown' ? 'preview' : 'raw');
      // History is metadata only, so this stays cheap even with many versions.
      setVersions(await api.versions(sessionId, artifactId));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('artifacts.loadFailed'));
    } finally {
      setBusyId(null);
    }
  }

  async function showVersion(version: number) {
    if (!api || !sessionId || !selected) return;
    if (version === selected.version) {
      setPreviewContent(selected.content);
      setViewingVersion(version);
      return;
    }
    try {
      const found = await api.version(sessionId, selected.id, version);
      if (!found) {
        setError(t('artifacts.notFound'));
        return;
      }
      setPreviewContent(found.content);
      setViewingVersion(version);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('artifacts.loadFailed'));
    }
  }

  async function remove(artifactId: string) {
    if (!api || !sessionId) return;
    setBusyId(artifactId);
    setError(null);
    try {
      const result = await api.delete(sessionId, artifactId);
      if (result.success) {
        setSelected(null);
        setPreviewContent(null);
        setVersions([]);
        await load();
        return;
      }
      // The refusal is reported, not swallowed: an unconfirmed delete must not
      // look like it worked.
      setError(
        result.error === 'confirmation_denied'
          ? t('artifacts.deleteDeclined')
          : t('artifacts.deleteFailed')
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : t('artifacts.deleteFailed'));
    } finally {
      setBusyId(null);
    }
  }

  async function handleCopy() {
    if (previewContent && (await copyTextToClipboard(previewContent))) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  const isHistorical = viewingVersion !== null && selected !== null && viewingVersion !== selected.version;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Layers className="w-4 h-4 text-accent flex-shrink-0" />
          <h3 className="text-sm font-semibold text-text-primary truncate">{t('artifacts.title')}</h3>
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
            {t('artifacts.scopeSession')}
          </button>
          <button
            onClick={() => onScopeChange('project')}
            className={`px-2.5 py-1 rounded-md transition-colors ${
              scope === 'project'
                ? 'bg-accent text-white font-medium shadow-sm'
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            {t('artifacts.scopeProject')}
          </button>
        </div>
      </div>

      <p className="text-xs text-text-muted">{t('artifacts.desc')}</p>

      {error && (
        <div className="p-3 rounded-xl bg-error/10 border border-error/30 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-error flex-shrink-0 mt-0.5" />
          <span className="text-xs text-error">{error}</span>
        </div>
      )}

      {!sessionId ? (
        <p className="text-xs text-text-muted py-4 text-center">{t('artifacts.noSession')}</p>
      ) : isLoading ? (
        <div className="flex items-center justify-center py-6">
          <Loader2 className="w-5 h-5 animate-spin text-accent" />
        </div>
      ) : artifacts.length === 0 ? (
        <p className="text-xs text-text-muted py-6 text-center">{t('artifacts.empty')}</p>
      ) : (
        <div className="space-y-1.5">
          {artifacts.map((artifact) => (
            <div
              key={artifact.id}
              className={`flex items-center gap-2 p-2.5 rounded-xl border transition-colors ${
                selected?.id === artifact.id
                  ? 'border-accent/50 bg-accent/5'
                  : 'border-border-subtle bg-surface hover:bg-surface-hover'
              }`}
            >
              <button
                onClick={() => open(artifact.id)}
                disabled={busyId === artifact.id}
                className="flex items-center gap-2.5 flex-1 min-w-0 text-left disabled:opacity-60"
              >
                {busyId === artifact.id ? (
                  <Loader2 className="w-4 h-4 text-accent animate-spin flex-shrink-0" />
                ) : (
                  <FileText className="w-4 h-4 text-text-muted flex-shrink-0" />
                )}
                <div className="min-w-0">
                  <p className="text-xs font-medium text-text-primary truncate">{artifact.title}</p>
                  <p className="text-[10px] text-text-muted truncate">
                    {t('artifacts.versionLabel', { version: artifact.version })}
                    {` · ${new Date(artifact.updatedAt).toLocaleString()}`}
                  </p>
                </div>
              </button>
              <button
                onClick={() => remove(artifact.id)}
                disabled={busyId === artifact.id}
                className="p-1.5 rounded-lg text-text-muted hover:text-error transition-colors disabled:opacity-50"
                title={t('artifacts.delete')}
                aria-label={t('artifacts.delete')}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {selected && (
        <div className="space-y-2 pt-2 border-t border-border-subtle">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              {selected.kind === 'markdown' && (
                <div className="flex bg-surface-muted p-0.5 rounded-lg border border-border text-xs flex-shrink-0">
                  <button
                    onClick={() => setMode('preview')}
                    className={`flex items-center gap-1 px-2 py-1 rounded-md transition-colors ${
                      mode === 'preview'
                        ? 'bg-accent text-white font-medium'
                        : 'text-text-secondary hover:text-text-primary'
                    }`}
                  >
                    <Eye className="w-3 h-3" />
                    {t('artifacts.rendered')}
                  </button>
                  <button
                    onClick={() => setMode('raw')}
                    className={`flex items-center gap-1 px-2 py-1 rounded-md transition-colors ${
                      mode === 'raw'
                        ? 'bg-accent text-white font-medium'
                        : 'text-text-secondary hover:text-text-primary'
                    }`}
                  >
                    <Code className="w-3 h-3" />
                    {t('artifacts.source')}
                  </button>
                </div>
              )}
              <button
                onClick={handleCopy}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-border bg-surface hover:bg-surface-hover text-xs text-text-secondary transition-colors flex-shrink-0"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
                {t('artifacts.copy')}
              </button>
              <button
                onClick={() => {
                  setSelected(null);
                  setPreviewContent(null);
                  setVersions([]);
                }}
                className="p-1.5 rounded-lg text-text-muted hover:text-text-primary transition-colors flex-shrink-0"
                aria-label={t('artifacts.close')}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            {isHistorical && (
              <span className="text-[10px] text-warning flex-shrink-0">
                {t('artifacts.viewingHistory', { version: viewingVersion ?? 0 })}
              </span>
            )}
          </div>

          {versions.length > 1 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <History className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />
              {versions.map((v) => (
                <button
                  key={v.version}
                  onClick={() => showVersion(v.version)}
                  className={`px-2 py-0.5 rounded text-[10px] font-mono transition-colors ${
                    viewingVersion === v.version
                      ? 'bg-accent text-white font-medium'
                      : 'bg-surface-muted text-text-secondary hover:text-text-primary border border-border'
                  }`}
                  title={new Date(v.createdAt).toLocaleString()}
                >
                  v{v.version}
                </button>
              ))}
            </div>
          )}

          <pre
            className={`max-h-80 overflow-auto p-3 rounded-xl bg-background border border-border-subtle text-text-primary ${
              mode === 'raw' ? 'text-xs font-mono whitespace-pre-wrap' : 'text-xs font-sans whitespace-pre-wrap'
            }`}
          >
            {previewContent}
          </pre>
        </div>
      )}
    </div>
  );
}