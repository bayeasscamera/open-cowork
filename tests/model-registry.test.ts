import { describe, expect, it } from 'vitest';
import {
  ALLOWED_REGISTRY_HOSTS,
  MAX_REGISTRY_FILE_BYTES,
  validateRegistryEntry,
} from '../src/main/agent/model-registry';

const SHA = 'a'.repeat(64);

describe('validateRegistryEntry', () => {
  it('accepts a well-formed repository id and builds the canonical URL', () => {
    const result = validateRegistryEntry({ repoId: 'org/model-GGUF' });
    expect(result.valid).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.normalizedUrl).toBe('https://huggingface.co/org/model-GGUF');
    expect(result.host).toBe('huggingface.co');
    expect(result.suggestedProfile).toBe('local');
  });

  it('suggests a profile from the repository name', () => {
    expect(validateRegistryEntry({ repoId: 'org/model-coder' }).suggestedProfile).toBe('balanced');
    expect(validateRegistryEntry({ repoId: 'org/tiny-1b' }).suggestedProfile).toBe('fast');
    expect(validateRegistryEntry({ repoId: 'org/reasoner-70b' }).suggestedProfile).toBe('strong');
    expect(validateRegistryEntry({ repoId: 'org/unknown', taskKinds: ['review'] }).suggestedProfile).toBe(
      'strong'
    );
    expect(
      validateRegistryEntry({ repoId: 'org/unknown', taskKinds: ['implementation'] }).suggestedProfile
    ).toBe('balanced');
    expect(validateRegistryEntry({ repoId: 'org/unknown' }).suggestedProfile).toBeNull();
  });

  it('rejects malformed repository ids', () => {
    expect(validateRegistryEntry({ repoId: '' }).reasons).toEqual(['A repository id is required.']);
    expect(validateRegistryEntry({ repoId: 'bad id' }).reasons).toEqual([
      'Repository id must look like "org/model".',
    ]);
  });

  it('only accepts allowlisted HTTPS hosts', () => {
    expect(ALLOWED_REGISTRY_HOSTS).toContain('huggingface.co');

    const foreign = validateRegistryEntry({ repoId: 'org/model', url: 'https://evil.example.com/model' });
    expect(foreign.valid).toBe(false);
    expect(foreign.reasons).toContain('Host is not an allowlisted registry: evil.example.com');

    const insecure = validateRegistryEntry({ repoId: 'org/model', url: 'http://huggingface.co/model' });
    expect(insecure.reasons).toContain('Only HTTPS registry URLs are accepted.');

    const broken = validateRegistryEntry({ repoId: 'org/model', url: 'not-a-url' });
    expect(broken.reasons).toContain('The registry URL is not a valid URL.');
  });

  it('rejects traversal file names, bad hashes and impossible sizes', () => {
    expect(validateRegistryEntry({ repoId: 'org/model', fileName: '../evil.gguf' }).reasons).toContain(
      'File name must be a plain file name without traversal.'
    );
    expect(validateRegistryEntry({ repoId: 'org/model', sha256: 'deadbeef' }).reasons).toContain(
      'sha256 must be a 64-character hex digest.'
    );
    expect(validateRegistryEntry({ repoId: 'org/model', sizeBytes: 0 }).reasons).toContain(
      'sizeBytes must be a positive number.'
    );
    expect(
      validateRegistryEntry({ repoId: 'org/model', sizeBytes: MAX_REGISTRY_FILE_BYTES + 1 }).reasons
    ).toContain('File is larger than the 40 GB safety limit.');
  });

  it('accepts a fully specified, valid entry', () => {
    const result = validateRegistryEntry({
      repoId: 'org/model-GGUF',
      url: 'https://huggingface.co/org/model-GGUF',
      fileName: 'model-q4_k_m.gguf',
      sizeBytes: 4_000_000_000,
      sha256: SHA,
    });
    expect(result.valid).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('never suggests a profile for an invalid entry', () => {
    expect(validateRegistryEntry({ repoId: '', taskKinds: ['review'] }).suggestedProfile).toBeNull();
  });
});
