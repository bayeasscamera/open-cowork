import { describe, expect, it } from 'vitest';
import { redactSensitiveValues } from '../src/main/cli/headless-io';

describe('headless stdout redaction', () => {
  it('strips credentials from nested event payloads', () => {
    const event = {
      type: 'config.status',
      payload: {
        config: {
          apiKey: 'secret-key',
          tavilyApiKey: 'tvly-secret',
          braveApiKey: 'brave-secret',
          model: 'z-ai/glm-5.3-flash',
          baseUrl: 'https://api.example.com/v1',
          profiles: { openai: { apiKey: 'nested-secret', model: 'gpt' } },
          configSets: [
            { id: 'set-1', profiles: { custom: { apiKey: 'set-secret' } } },
          ],
        },
      },
    };
    const redacted = JSON.parse(JSON.stringify(redactSensitiveValues(event))) as typeof event;
    expect(redacted.payload.config.apiKey).toBe('[REDACTED]');
    expect(redacted.payload.config.tavilyApiKey).toBe('[REDACTED]');
    expect(redacted.payload.config.braveApiKey).toBe('[REDACTED]');
    expect(redacted.payload.config.profiles.openai.apiKey).toBe('[REDACTED]');
    expect(redacted.payload.config.configSets[0].profiles.custom.apiKey).toBe('[REDACTED]');
    // Non-sensitive values are preserved untouched.
    expect(redacted.payload.config.model).toBe('z-ai/glm-5.3-flash');
    expect(redacted.payload.config.baseUrl).toBe('https://api.example.com/v1');
    expect(redacted.payload.config.profiles.openai.model).toBe('gpt');
  });

  it('leaves empty credential fields empty and primitives intact', () => {
    expect(redactSensitiveValues({ apiKey: '', note: 'x' })).toEqual({ apiKey: '', note: 'x' });
    expect(redactSensitiveValues('plain')).toBe('plain');
    expect(redactSensitiveValues(42)).toBe(42);
  });
});