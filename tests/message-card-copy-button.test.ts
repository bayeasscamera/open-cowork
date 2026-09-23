import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const messageCardPath = path.resolve(process.cwd(), 'src/renderer/components/MessageCard.tsx');
const enLocalePath = path.resolve(process.cwd(), 'src/renderer/i18n/locales/en.json');
const frLocalePath = path.resolve(process.cwd(), 'src/renderer/i18n/locales/fr.json');

describe('MessageCard copy button', () => {
  it('renders a copy action next to retry on assistant messages', () => {
    const source = fs.readFileSync(messageCardPath, 'utf8');
    // Copy button wired to the existing handler and i18n keys
    expect(source).toContain('onClick={handleCopy}');
    expect(source).toContain("t('messageCard.copyResponse')");
    // Visual feedback: Copy icon swaps to Check while the copied state is active
    expect(source).toContain("{copied ? <Check className=\"w-3 h-3\" /> : <Copy className=\"w-3 h-3\" />}");
    expect(source).toContain("copied ? t('messageCard.copied') : t('messageCard.copyResponse')");
  });

  it('keeps the retry button inside the same hover action bar', () => {
    const source = fs.readFileSync(messageCardPath, 'utf8');
    expect(source).toContain("{onRetry && (");
    expect(source).toContain("t('messageCard.retryResponse')");
    // The action bar stays hover-revealed and hidden while streaming
    expect(source).toContain('opacity-0 group-hover:opacity-100 transition-opacity pt-1 flex items-center gap-1.5');
    expect(source).toContain('{!isStreaming && (');
  });

  it('declares the new strings in en and fr locales', () => {
    const en = JSON.parse(fs.readFileSync(enLocalePath, 'utf8')) as {
      messageCard: Record<string, string>;
    };
    const fr = JSON.parse(fs.readFileSync(frLocalePath, 'utf8')) as {
      messageCard: Record<string, string>;
    };
    expect(en.messageCard.copyResponse).toBe('Copy response');
    expect(en.messageCard.copied).toBe('Copied!');
    expect(fr.messageCard.copyResponse).toBe('Copier la réponse');
    expect(fr.messageCard.copied).toBe('Copié !');
  });
});
