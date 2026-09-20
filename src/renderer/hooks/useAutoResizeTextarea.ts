import { useEffect, type RefObject } from 'react';

/**
 * Claude-Desktop-style auto-growing textarea.
 *
 * The field expands with its content up to ~40% of the window height, then
 * scrolls INTERNALLY (overflow-y: auto) — the text never overflows outside the
 * field's rounded box, and the buttons around it stay anchored by the layout
 * (flex items-end). Recomputed on every value change and on window resize.
 */
export function useAutoResizeTextarea(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  value: string
): void {
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    const maxHeight = Math.max(160, Math.round(window.innerHeight * 0.4));
    const newHeight = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${newHeight}px`;
    // Internal scrollbar appears only once the cap is reached.
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [value, textareaRef]);

  useEffect(() => {
    const recompute = () => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.style.height = 'auto';
      const maxHeight = Math.max(160, Math.round(window.innerHeight * 0.4));
      textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
      textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
    };
    window.addEventListener('resize', recompute);
    return () => window.removeEventListener('resize', recompute);
  }, [textareaRef]);
}