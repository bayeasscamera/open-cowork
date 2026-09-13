import { useState, useEffect } from 'react';
import { X, Copy, Check, ExternalLink, FileText, Code, Eye } from 'lucide-react';

interface ArtifactModalProps {
  filePath: string;
  onClose: () => void;
  onRevealInFolder: (path: string) => void;
}

export function ArtifactModal({ filePath, onClose, onRevealInFolder }: ArtifactModalProps) {
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<boolean>(false);
  const [mode, setMode] = useState<'preview' | 'raw'>('preview');

  const fileName = filePath.split('/').pop() || filePath.split('\\').pop() || 'Artifact';
  const ext = fileName.split('.').pop()?.toLowerCase() || '';

  const isHtml = ext === 'html' || ext === 'htm';
  const isSvg = ext === 'svg';

  useEffect(() => {
    let isMounted = true;
    setLoading(true);
    setError(null);

    async function load() {
      try {
        if (window.electronAPI?.artifacts?.readFile) {
          const res = await window.electronAPI.artifacts.readFile(filePath);
          if (isMounted) {
            setContent(res);
          }
        } else {
          throw new Error('Lecture de fichier non disponible');
        }
      } catch (err: unknown) {
        if (isMounted) {
          setError(err instanceof Error ? err.message : 'Impossible de charger le fichier');
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    }

    load();
    return () => {
      isMounted = false;
    };
  }, [filePath]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div
        className="flex flex-col w-full max-w-4xl h-[85vh] bg-surface rounded-2xl border border-border shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-surface-muted/50">
          <div className="flex items-center gap-2.5 min-w-0">
            <FileText className="w-5 h-5 text-accent shrink-0" />
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-text-primary truncate">{fileName}</h3>
              <p className="text-[11px] text-text-muted truncate font-mono">{filePath}</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {(isHtml || isSvg) && (
              <div className="flex bg-surface-muted p-0.5 rounded-lg border border-border text-xs">
                <button
                  onClick={() => setMode('preview')}
                  className={`flex items-center gap-1 px-2.5 py-1 rounded-md transition-colors ${
                    mode === 'preview'
                      ? 'bg-accent text-white font-medium shadow-sm'
                      : 'text-text-secondary hover:text-text-primary'
                  }`}
                >
                  <Eye className="w-3.5 h-3.5" />
                  Rendu
                </button>
                <button
                  onClick={() => setMode('raw')}
                  className={`flex items-center gap-1 px-2.5 py-1 rounded-md transition-colors ${
                    mode === 'raw'
                      ? 'bg-accent text-white font-medium shadow-sm'
                      : 'text-text-secondary hover:text-text-primary'
                  }`}
                >
                  <Code className="w-3.5 h-3.5" />
                  Code
                </button>
              </div>
            )}

            <button
              onClick={handleCopy}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-border bg-surface hover:bg-surface-hover text-xs font-medium text-text-secondary transition-colors"
              title="Copier le contenu"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copied ? 'Copié' : 'Copier'}</span>
            </button>

            <button
              onClick={() => onRevealInFolder(filePath)}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-border bg-surface hover:bg-surface-hover text-xs font-medium text-text-secondary transition-colors"
              title="Afficher dans le dossier"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              <span>Dossier</span>
            </button>

            <button
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-surface-hover text-text-muted hover:text-text-primary transition-colors ml-1"
              title="Fermer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-auto bg-background p-6">
          {loading ? (
            <div className="flex items-center justify-center h-full text-text-muted text-sm">
              Chargement de l'aperçu...
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center h-full text-red-400 gap-2">
              <p className="text-sm font-medium">{error}</p>
              <button
                onClick={() => onRevealInFolder(filePath)}
                className="text-xs underline text-accent"
              >
                Ouvrir directement dans le dossier
              </button>
            </div>
          ) : (isHtml || isSvg) && mode === 'preview' ? (
            <iframe
              srcDoc={content}
              title={fileName}
              sandbox="allow-scripts allow-same-origin"
              className="w-full h-full border-0 rounded-lg bg-white shadow-inner"
            />
          ) : (
            <pre className="text-xs font-mono text-text-primary whitespace-pre-wrap leading-relaxed select-text">
              {content}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
