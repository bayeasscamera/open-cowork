import { describe, expect, it } from 'vitest';
import { buildAttachmentPromptHints } from '../src/main/session/attachment-hints';

describe('buildAttachmentPromptHints', () => {
  it('returns null when nothing was attached', () => {
    expect(buildAttachmentPromptHints({})).toBeNull();
    expect(buildAttachmentPromptHints({ files: [], images: [] })).toBeNull();
  });

  it('keeps the historical Read hint for file attachments', () => {
    const hints = buildAttachmentPromptHints({
      files: [{ filename: 'notes.md', relativePath: '.tmp/notes.md', size: 2048 }],
    });
    expect(hints).toContain('[Attached files - use Read tool to access them]:');
    expect(hints).toContain('- notes.md (2.0 KB) at path: .tmp/notes.md');
  });

  it('announces pasted images by workspace path so the agent can call analyze_image', () => {
    const hints = buildAttachmentPromptHints({ images: ['.tmp/pasted-1.png'] });
    expect(hints).toContain('[Images attached by the user - call analyze_image on these paths to see them]:');
    expect(hints).toContain('- .tmp/pasted-1.png');
  });

  it('lists files before images and drops empty image paths', () => {
    const hints = buildAttachmentPromptHints({
      files: [{ filename: 'a.txt', relativePath: '.tmp/a.txt', size: 1024 }],
      images: ['  ', '.tmp/b.png'],
    });
    expect(hints).toBe(
      '[Attached files - use Read tool to access them]:\n- a.txt (1.0 KB) at path: .tmp/a.txt\n\n' +
        '[Images attached by the user - call analyze_image on these paths to see them]:\n- .tmp/b.png'
    );
  });
});
