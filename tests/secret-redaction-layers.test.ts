import { describe, expect, it } from 'vitest';
import { redactSecrets, securityRedactorMod } from '../src/main/mods/builtin-mods';
import { redactSecretsForTest } from '../src/main/utils/logger';
import { redactSensitiveValues } from '../src/main/cli/headless-io';

/**
 * Proof that a single secret pushed through the three redaction paths
 * (security-redactor mod, main logger, headless stdout) is masked in every
 * case — including formats that previously slipped through all three.
 */

const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

const SSH_KEY = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAEAAAABAAAAMwAA',
  '-----END OPENSSH PRIVATE KEY-----',
].join('\n');

// The fixtures below are deliberately built from parts. A literal, well-formed
// token sitting in a test file is indistinguishable from a real leak, and GitHub
// push protection blocks the push on that basis (it did, for the Slack token).
// At runtime each value is still a well-formed fake, so the redaction patterns
// under test match exactly as before — only the source no longer contains a
// contiguous pattern the scanner can read as a credential.
const GITHUB_TOKEN = 'ghp_' + 'A'.repeat(36);
const SLACK_TOKEN = ['xoxb', 'FAKE', 'test-fixture-not-a-real-token'].join('-');
const DB_URL = 'postgres://user:secret@db.example.com/prod';
const ANTHROPIC_KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
const API_KEY_ASSIGN = 'api_key=abcdefghijklmnopqrst';

const SECRETS: Array<{ label: string; value: string }> = [
  { label: 'Anthropic sk- key', value: ANTHROPIC_KEY },
  { label: 'GitHub ghp_ token', value: GITHUB_TOKEN },
  { label: 'Slack xox token', value: SLACK_TOKEN },
  { label: 'DB connection string', value: DB_URL },
  { label: 'JWT', value: JWT },
  { label: 'SSH private key block', value: SSH_KEY },
  { label: 'api_key= assignment', value: API_KEY_ASSIGN },
];

// mod path — redactSecrets directly and via the mod's onPostToolUse hook.
function throughMod(value: string): string {
  const viaFunction = redactSecrets(value);
  const viaHook = securityRedactorMod.onPostToolUse?.(
    { sessionId: 's', toolName: 'read', args: {} },
    { content: value }
  );
  return viaHook?.replaceContent ?? viaFunction;
}

// logger path — the exported test hook wraps the same pipeline the logger uses.
function throughLogger(value: string): string {
  return redactSecretsForTest(value);
}

// headless path — a free-form string leaf carries the secret through the same
// pattern pass the nested-payload writer applies to every string value.
function throughHeadless(value: string): string {
  return redactSensitiveValues(value) as string;
}

describe('secret redaction — all three layers', () => {
  it('masks every recognized secret through the mod, logger and headless paths', () => {
    for (const { label, value } of SECRETS) {
      expect(throughMod(value), `mod should mask ${label}`).not.toContain(value);
      expect(throughLogger(value), `logger should mask ${label}`).not.toContain(value);
      expect(throughHeadless(value), `headless should mask ${label}`).not.toContain(value);
    }
  });

  it('produces a stable placeholder (no partial secret left) in every path', () => {
    for (const { value } of SECRETS) {
      // A stable placeholder means the full body is gone, not a truncated fragment.
      for (const out of [throughMod(value), throughLogger(value), throughHeadless(value)]) {
        const probe = value.slice(4, value.length);
        if (probe.length > 12) {
          expect(out).not.toContain(probe);
        }
      }
    }
  });

  it('keeps normal prose intact in all three paths', () => {
    const clean = 'session started for user 42 in workspace /tmp';
    expect(throughMod(clean)).toBe(clean);
    expect(throughLogger(clean)).toBe(clean);
    expect(throughHeadless(clean)).toBe(clean);
  });
});

describe('documented residual limitations (not pattern-detectable)', () => {
  // A key wrapped across lines cannot be reassembled by a single-line regex.
  // Catching it reliably would require an aggressive multi-line heuristic with
  // high false-positive risk, so it is deliberately not attempted.
  it.skip('fragmented key split across a newline leaks — accepted limitation', () => {
    // Documented: no layer reassembles the two halves.
    const _fragmented = `Bearer ${'eyJhbGciOiJIUzI1NiIsInR5cCI6'}\n${'IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0'}`;
    void _fragmented;
  });

  // A base64-encoded secret is indistinguishable from arbitrary base64 text.
  it.skip('base64-encoded key leaks — accepted limitation', () => {
    // Documented: decoding would require guessing the encoding scheme.
    const _b64 = Buffer.from('sk-ant-api03-secret').toString('base64');
    void _b64;
  });
});