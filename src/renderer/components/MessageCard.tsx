// MessageCard — top-level chat message renderer.
// Delegates block rendering to ContentBlockView and its sub-components.
import { useState, memo, useMemo, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Check, Clock, XCircle, Pencil, RefreshCw } from 'lucide-react';
import type { Message, ContentBlock, ToolUseContent, ToolResultContent } from '../types';
import { ContentBlockView } from './message/ContentBlockView';

interface MessageCardProps {
  message: Message;
  isStreaming?: boolean;
  onEdit?: (messageId: string, newContent: string) => void;
  onRetry?: (messageId: string) => void;
}

export const MessageCard = memo(function MessageCard({
  message,
  isStreaming,
  onEdit,
  onRetry,
}: MessageCardProps) {
  const { t } = useTranslation();
  const isUser = message.role === 'user';
  const isQueued = message.localStatus === 'queued';
  const isCancelled = message.localStatus === 'cancelled';
  const rawContent = message.content as unknown;
  const contentBlocks = useMemo(
    () =>
      Array.isArray(rawContent)
        ? (rawContent as ContentBlock[])
        : [{ type: 'text', text: String(rawContent ?? '') } as ContentBlock],
    [rawContent]
  );
  const [copied, setCopied] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Build a set of tool_result IDs that have a matching tool_use (for merging)
  const mergedResultIds = useMemo(() => {
    const ids = new Set<string>();
    for (const b of contentBlocks) {
      if (b.type === 'tool_use') {
        const tu = b as ToolUseContent;
        const result = contentBlocks.find(
          (r) => r.type === 'tool_result' && (r as ToolResultContent).toolUseId === tu.id
        );
        if (result) ids.add((result as ToolResultContent).toolUseId);
      }
    }
    return ids;
  }, [contentBlocks]);

  // Extract text content for copying / editing
  const getTextContent = () =>
    contentBlocks
      .filter((block) => block.type === 'text')
      .map((block) => (block as { type: 'text'; text: string }).text)
      .join('\n');

  const handleCopy = async () => {
    const text = getTextContent();
    if (text) {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        // Clipboard unavailable
      }
    }
  };

  const handleStartEdit = () => {
    setEditText(getTextContent());
    setIsEditing(true);
  };

  const handleSaveEdit = () => {
    const trimmed = editText.trim();
    if (trimmed && onEdit) {
      onEdit(message.id, trimmed);
    }
    setIsEditing(false);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
  };

  // Auto-resize textarea and focus when editing starts
  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.selectionStart = textareaRef.current.value.length;
    }
  }, [isEditing]);

  // Ctrl+Enter submits, Escape cancels
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSaveEdit();
    } else if (e.key === 'Escape') {
      handleCancelEdit();
    }
  };

  return (
    <div className="animate-fade-in">
      {isUser ? (
        // User message - compact styling with smaller padding and radius
        <div className="flex items-start gap-2 justify-end group">
          {isEditing ? (
            // Inline edit mode
            <div className="flex flex-col gap-2 max-w-[80%] w-full">
              <textarea
                ref={textareaRef}
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                onKeyDown={handleKeyDown}
                rows={Math.max(3, editText.split('\n').length)}
                className="w-full px-4 py-3 rounded-2xl bg-surface-muted border border-border-subtle text-text-primary resize-none focus:outline-none focus:ring-2 focus:ring-accent/50 text-sm"
              />
              <div className="flex gap-2 justify-end">
                <button
                  onClick={handleCancelEdit}
                  className="px-3 py-1.5 text-xs rounded-lg bg-surface-muted hover:bg-surface-active text-text-secondary transition-colors"
                >
                  {t('messageCard.cancel')}
                </button>
                <button
                  onClick={handleSaveEdit}
                  disabled={!editText.trim()}
                  className="px-3 py-1.5 text-xs rounded-lg bg-accent hover:bg-accent/90 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {t('messageCard.save')}
                </button>
              </div>
            </div>
          ) : (
            <>
              <div
                className={`message-user px-4 py-3 rounded-[1.65rem] max-w-[80%] min-w-0 break-words ${
                  isQueued ? 'opacity-70 border-dashed' : ''
                } ${isCancelled ? 'opacity-60' : ''}`}
              >
                {isQueued && (
                  <div className="mb-1 flex items-center gap-1 text-[11px] text-text-muted">
                    <Clock className="w-3 h-3" />
                    <span>{t('messageCard.queued')}</span>
                  </div>
                )}
                {isCancelled && (
                  <div className="mb-1 flex items-center gap-1 text-[11px] text-text-muted">
                    <XCircle className="w-3 h-3" />
                    <span>{t('messageCard.cancelled')}</span>
                  </div>
                )}
                {contentBlocks.length === 0 ? (
                  <span className="text-text-muted italic">{t('messageCard.emptyMessage')}</span>
                ) : (
                  contentBlocks.map((block, index) => (
                    <ContentBlockView
                      key={
                        'id' in block ? (block as { id: string }).id : `block-${block.type}-${index}`
                      }
                      block={block}
                      isUser={isUser}
                      isStreaming={isStreaming}
                    />
                  ))
                )}
              </div>
              {/* Action buttons: edit + copy */}
              <div className="flex flex-col gap-1 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
                {onEdit && !isQueued && !isCancelled && !isStreaming && (
                  <button
                    onClick={handleStartEdit}
                    className="w-6 h-6 flex items-center justify-center rounded-md bg-surface-muted hover:bg-surface-active transition-all flex-shrink-0"
                    title={t('messageCard.editMessage')}
                  >
                    <Pencil className="w-3 h-3 text-text-muted" />
                  </button>
                )}
                <button
                  onClick={handleCopy}
                  className="w-6 h-6 flex items-center justify-center rounded-md bg-surface-muted hover:bg-surface-active transition-all flex-shrink-0"
                  title={t('messageCard.copyMessage')}
                >
                  {copied ? (
                    <Check className="w-3 h-3 text-success" />
                  ) : (
                    <Copy className="w-3 h-3 text-text-muted" />
                  )}
                </button>
              </div>
            </>
          )}
        </div>
      ) : (
        // Assistant message — no bubble, direct content (Claude style)
        <div className="group space-y-1.5">
          {contentBlocks.map((block, index) => {
            // Skip tool_result blocks that are merged into their tool_use card
            if (
              block.type === 'tool_result' &&
              mergedResultIds.has((block as ToolResultContent).toolUseId)
            ) {
              return null;
            }
            return (
              <ContentBlockView
                key={'id' in block ? (block as { id: string }).id : `block-${block.type}-${index}`}
                block={block}
                isUser={isUser}
                isStreaming={isStreaming}
                allBlocks={contentBlocks}
                message={message}
              />
            );
          })}
          {/* Retry button — visible on hover, only when not streaming */}
          {onRetry && !isStreaming && (
            <div className="opacity-0 group-hover:opacity-100 transition-opacity pt-1">
              <button
                onClick={() => onRetry(message.id)}
                className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] rounded-lg bg-surface-muted hover:bg-surface-active text-text-muted hover:text-text-secondary transition-all"
                title={t('messageCard.retryResponse')}
              >
                <RefreshCw className="w-3 h-3" />
                {t('messageCard.retryResponse')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
