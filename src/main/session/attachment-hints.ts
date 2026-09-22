/**
 * @module main/session/attachment-hints
 *
 * Pure builder for the prompt preamble that tells the agent where the files and
 * images a user attached now live. Extracted from SessionManager so it can be
 * unit-tested without booting Electron.
 *
 * The chat model itself is text-only, so an attached image is only "seen" once
 * its workspace path is in the prompt and the agent calls the analyze_image
 * (vision) tool on it. Files keep the historical "use Read" hint.
 */

export interface AttachedFileHint {
  filename: string;
  relativePath: string;
  size: number;
}

export interface AttachmentHintInput {
  files?: AttachedFileHint[];
  /** Workspace-relative paths of images the user pasted or attached. */
  images?: string[];
}

/**
 * Render the attachment preamble, or null when there is nothing to announce.
 * Order is stable (files first, then images) so tests and prompts stay diffable.
 */
export function buildAttachmentPromptHints(input: AttachmentHintInput): string | null {
  const sections: string[] = [];

  const files = input.files ?? [];
  if (files.length > 0) {
    const lines = files
      .map(
        (file) =>
          `- ${file.filename} (${(file.size / 1024).toFixed(1)} KB) at path: ${file.relativePath}`
      )
      .join('\n');
    sections.push(`[Attached files - use Read tool to access them]:\n${lines}`);
  }

  const images = (input.images ?? []).filter(
    (candidate) => typeof candidate === 'string' && candidate.trim().length > 0
  );
  if (images.length > 0) {
    const lines = images.map((candidate) => `- ${candidate.trim()}`).join('\n');
    sections.push(
      `[Images attached by the user - call analyze_image on these paths to see them]:\n${lines}`
    );
  }

  return sections.length > 0 ? sections.join('\n\n') : null;
}
