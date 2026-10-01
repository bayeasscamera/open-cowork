/**
 * @module main/utils/secret-redaction
 *
 * Single source of truth for secret redaction. Every channel that can carry a
 * credential applies this same rule set:
 *   - the security-redactor mod   (src/main/mods/builtin-mods.ts)
 *   - the main logger            (src/main/utils/logger.ts)
 *   - the headless stdout writer  (src/main/cli/headless-io.ts)
 *   - the memory pipeline         (transcripts at ingestion, memory files on
 *     write, persisted ingest errors — so secrets pasted in chat never rest
 *     in cleartext on disk and never leave for the LLM/embedding provider)
 *
 * Rules run in order; specific token patterns (sk-, ghp_, JWT, SSH, …) must run
 * BEFORE the generic `key=value` rule so a prefixed key is attributed to its own
 * placeholder instead of being eaten by the generic mask. A matched secret is
 * replaced entirely by its placeholder, so later layers never see a live secret.
 */

interface SecretRedactionRule {
  pattern: RegExp;
  /** Fixed placeholder, or a replacer `(match, groups) => replacement`. */
  placeholder: string | ((match: string, groups: string[]) => string);
}

const SECRET_REDACTION_RULES: SecretRedactionRule[] = [
  // sk- / rk- / pk- style API keys (Anthropic et similaires).
  { pattern: /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, placeholder: '[REDACTED-KEY]' },
  // GitHub personal / OAuth / fine-grained tokens.
  { pattern: /\bghp_[A-Za-z0-9]{30,}\b/g, placeholder: '[REDACTED-TOKEN]' },
  { pattern: /\bgho_[A-Za-z0-9]{30,}\b/g, placeholder: '[REDACTED-TOKEN]' },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g, placeholder: '[REDACTED-TOKEN]' },
  // GitLab personal access tokens.
  { pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g, placeholder: '[REDACTED-TOKEN]' },
  // AWS access key IDs (the secret key travels with them too often to ignore).
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, placeholder: '[REDACTED-KEY]' },
  // Google API keys.
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, placeholder: '[REDACTED-KEY]' },
  // npm auth tokens (//registry…/:_authToken=… lines in .npmrc pastes).
  { pattern: /_authToken\s*=\s*[A-Za-z0-9._~+/-]{12,}/g, placeholder: '_authToken=[REDACTED]' },
  // Slack tokens (xoxb- / xoxa- / xoxp- / xoxr- / xoxs-).
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, placeholder: '[REDACTED-TOKEN]' },
  // HTTP Authorization bearer tokens.
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, placeholder: '[REDACTED-TOKEN]' },
  // Database connection strings (user:pass@host).
  {
    pattern:
      /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s"'`<>\]]+@\S+/g,
    placeholder: '[REDACTED-CONNECTION]',
  },
  // JSON Web Tokens (3 base64url segments, header starts with the `eyJ` magic).
  {
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g,
    placeholder: '[REDACTED-TOKEN]',
  },
  // PEM private key blocks (RSA / DSA / EC / OPENSSH / PKCS#8).
  {
    pattern:
      /-----BEGIN (?:RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    placeholder: '[REDACTED-KEY]',
  },
  // Generic key=value secrets: keep the field name, mask the value.
  {
    pattern:
      /\b(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|refresh[_-]?token|secret|password|authorization)\b["'\s:=]{0,4}["']?([A-Za-z0-9._~+/=-]{12,})["']?/gi,
    placeholder: (match, groups) => {
      const value = groups[0];
      const keyEnd = value === undefined ? 0 : match.indexOf(value);
      return (keyEnd > 0 ? match.slice(0, keyEnd) : match) + '[REDACTED]';
    },
  },
];

/**
 * Apply every redaction rule to a text string. Returns a copy with all matched
 * secrets replaced by placeholders. Idempotent — safe to run more than once.
 */
export function redactSecrets(text: string): string {
  let result = text;
  for (const rule of SECRET_REDACTION_RULES) {
    result = result.replace(rule.pattern, (...args) => {
      const match = args[0];
      if (typeof rule.placeholder === 'function') {
        const groups = args.slice(1, -2) as string[];
        return rule.placeholder(match, groups);
      }
      return rule.placeholder;
    });
  }
  return result;
}