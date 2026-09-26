import { describe, expect, it } from 'vitest';
import {
  hasRawProtocolMarkup,
  quarantineRawProtocolMarkup,
} from '../src/renderer/utils/raw-protocol-markup';

// ─── Fixtures modelled on a real corrupted session ──────────────────────────
// Shapes observed when a model leaked its agent protocol as plain text
// (after an upstream 400): paired <tool_use>, replayed <turn>/<tool_result>
// transcripts, stray </turn> wrappers, <system_warning> and <output> blocks.

const PAIRED_TOOL_USE = `Voici le diagnostic.
<tool_use name="bash" id="call_9fbb6cb64bff4db998b39e1d">{"command":"cd /project &amp;&amp; pgrep -fl \\"worker\\" | head -4","timeout":30}</tool_use>
Et la suite du raisonnement.`;

const FULL_REPLAY = `Analyse du build.
<turn role="assistant">
<tool_use name="bash" id="call_a1e8d4f7b0c5e6a2d9f3b8">{"command":"git log --oneline -1"}</tool_use>
</turn>
<turn role="assistant">
<tool_result tool_use_id="call_a1e8d4f7b0c5e6a2d9f3b8">\`\`\`=== HEAD ===
c8a3b91 fix: previous change
\`\`\`</tool_result>
</turn>
Conclusion propre.`;

const STRAY_CLOSE_TURN = `Symptôme clair.
<tool_use name="read" id="call_5a1f2b7e0c8d4e3f9b0a6d2c">{"path":"/project/src/file.ts"}</tool_use>
<tool_use name="bash" id="call_2b8e4f0d6c1a9e3b5d7c8f2">{"command":"grep -n \\"## 9\\" docs/spec.md"}</tool_use></turn>

## Output

<system_warning>2 tool calls were executed in parallel.</system_warning>

<output>=== HEAD ===
c8a3b91
</output>`;

const UNTERMINATED = `Texte avant.
<tool_use name="bash" id="call_truncated">{"command":"echo jamais-term`;

const NORMAL_MARKDOWN = `# Titre normal

Un paragraphe qui parle d'appels d'outils (\`tool calls\`) sans balise brute.

\`\`\`xml
<note priority="high">exemple de XML légitime</note>
\`\`\`

- liste à puce
- lien: [docs](https://example.com)`;

describe('hasRawProtocolMarkup — detection gate', () => {
  it('detects paired tool_use markup', () => {
    expect(hasRawProtocolMarkup(PAIRED_TOOL_USE)).toBe(true);
  });

  it('detects replayed turn/tool_result transcripts', () => {
    expect(hasRawProtocolMarkup(FULL_REPLAY)).toBe(true);
  });

  it('detects stray close-turn wrappers and output blocks', () => {
    expect(hasRawProtocolMarkup(STRAY_CLOSE_TURN)).toBe(true);
  });

  it('detects unterminated (truncated stream) tool_use tags', () => {
    expect(hasRawProtocolMarkup(UNTERMINATED)).toBe(true);
  });

  it('does not flag normal markdown that merely mentions tool calls', () => {
    expect(hasRawProtocolMarkup(NORMAL_MARKDOWN)).toBe(false);
    expect(hasRawProtocolMarkup('Use the `bash` tool via tool calls. <div>html légitime</div>')).toBe(
      false
    );
    expect(hasRawProtocolMarkup('')).toBe(false);
  });
});

describe('quarantineRawProtocolMarkup — extraction', () => {
  it('extracts a paired tool_use segment and keeps the surrounding prose', () => {
    const { cleanText, fragments } = quarantineRawProtocolMarkup(PAIRED_TOOL_USE);
    expect(fragments).toHaveLength(1);
    expect(fragments[0]).toContain('<tool_use name="bash"');
    expect(fragments[0]).toContain('</tool_use>');
    expect(fragments[0]).toContain('&amp;&amp;'); // inner entities preserved verbatim
    expect(cleanText).toContain('Voici le diagnostic.');
    expect(cleanText).toContain('Et la suite du raisonnement.');
    expect(cleanText).not.toContain('<tool_use');
  });

  it('extracts a full replayed transcript including replayed results', () => {
    const { cleanText, fragments } = quarantineRawProtocolMarkup(FULL_REPLAY);
    expect(cleanText).toContain('Analyse du build.');
    expect(cleanText).toContain('Conclusion propre.');
    expect(cleanText).not.toContain('<turn');
    expect(cleanText).not.toContain('<tool_use');
    expect(cleanText).not.toContain('<tool_result');
    // The replayed tool result (with its fences) is captured in the fragments.
    const joined = fragments.join('\n');
    expect(joined).toContain('tool_use_id="call_a1e8d4f7b0c5e6a2d9f3b8"');
    expect(joined).toContain('c8a3b91 fix: previous change');
    // Fragments come out in document order.
    const useIdx = joined.indexOf('<tool_use');
    const resultIdx = joined.indexOf('<tool_result');
    expect(useIdx).toBeGreaterThan(-1);
    expect(resultIdx).toBeGreaterThan(useIdx);
  });

  it('handles stray close-turn, system_warning and output blocks', () => {
    const { cleanText, fragments } = quarantineRawProtocolMarkup(STRAY_CLOSE_TURN);
    expect(cleanText).toContain('Symptôme clair.');
    expect(cleanText).not.toContain('</turn>');
    expect(cleanText).not.toContain('<system_warning');
    expect(cleanText).not.toContain('<output>');
    expect(cleanText).not.toContain('c8a3b91'); // replayed output is quarantined, not shown
    expect(fragments.length).toBeGreaterThanOrEqual(4); // 2 tool_use + </turn> + warning + output
  });

  it('consumes an unterminated tool_use tag to the end of the text', () => {
    const { cleanText, fragments } = quarantineRawProtocolMarkup(UNTERMINATED);
    expect(cleanText).toContain('Texte avant.');
    expect(cleanText).not.toContain('<tool_use');
    expect(fragments.length).toBeGreaterThanOrEqual(1);
    expect(fragments[0]).toContain('call_truncated');
  });

  it('returns normal markdown untouched', () => {
    const result = quarantineRawProtocolMarkup(NORMAL_MARKDOWN);
    expect(result.fragments).toHaveLength(0);
    expect(result.cleanText).toBe(NORMAL_MARKDOWN);
  });

  it('collapses the blank lines left behind by removed segments', () => {
    const { cleanText } = quarantineRawProtocolMarkup(PAIRED_TOOL_USE);
    expect(cleanText).not.toMatch(/\n{3,}/);
  });

  it('keeps fenced code blocks that contain no protocol tags', () => {
    const text = `Explication :

\`\`\`
grep -rn "tool_use" src/ --include="*.ts"
\`\`\`

Fin.`;
    const result = quarantineRawProtocolMarkup(text);
    expect(result.fragments).toHaveLength(0);
    expect(result.cleanText).toContain('grep -rn "tool_use" src/');
  });
});
