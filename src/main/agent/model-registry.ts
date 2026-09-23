/**
 * @module main/agent/model-registry
 *
 * Cowork 4.0 — Phase 7.4: Hugging Face as an optional, validated registry. A
 * model reference is only accepted when it comes from an allowlisted host over
 * HTTPS, with a well-formed repo id and an optional integrity hash.
 */

import type {
  ModelProfileId,
  RegistryEntryInput,
  RegistryValidation,
  TaskKind,
} from '../../shared/model-routing-types';

export const ALLOWED_REGISTRY_HOSTS: readonly string[] = ['huggingface.co', 'www.huggingface.co'];
export const MAX_REGISTRY_FILE_BYTES = 40 * 1024 * 1024 * 1024;

const REPO_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

function suggestProfile(repoId: string, taskKinds?: readonly TaskKind[]): ModelProfileId | null {
  const id = repoId.toLowerCase();
  if (/coder|code/.test(id)) {
    return 'balanced';
  }
  if (/gguf|q[458]|awq|gptq|bnb/.test(id)) {
    return 'local';
  }
  if (/70b|72b|405b|large|reason/.test(id)) {
    return 'strong';
  }
  if (/7b|3b|1b|mini|small|tiny/.test(id)) {
    return 'fast';
  }
  if (taskKinds && taskKinds.length > 0) {
    return taskKinds.includes('review') ? 'strong' : 'balanced';
  }
  return null;
}

export function validateRegistryEntry(input: RegistryEntryInput): RegistryValidation {
  const reasons: string[] = [];
  const repoId = typeof input?.repoId === 'string' ? input.repoId.trim() : '';

  if (repoId.length === 0) {
    reasons.push('A repository id is required.');
  } else if (!REPO_ID_PATTERN.test(repoId)) {
    reasons.push('Repository id must look like "org/model".');
  }

  let normalizedUrl: string | null = null;
  let host: string | null = null;

  if (input?.url) {
    try {
      const url = new URL(input.url);
      host = url.hostname;
      if (url.protocol !== 'https:') {
        reasons.push('Only HTTPS registry URLs are accepted.');
      }
      if (!ALLOWED_REGISTRY_HOSTS.includes(url.hostname)) {
        reasons.push('Host is not an allowlisted registry: ' + url.hostname);
      }
      normalizedUrl = url.toString();
    } catch {
      reasons.push('The registry URL is not a valid URL.');
    }
  } else if (repoId.length > 0 && REPO_ID_PATTERN.test(repoId)) {
    normalizedUrl = 'https://huggingface.co/' + repoId;
    host = 'huggingface.co';
  }

  if (input?.fileName !== undefined) {
    const fileName = String(input.fileName);
    if (fileName.includes('..') || fileName.startsWith('/') || fileName.includes('\\')) {
      reasons.push('File name must be a plain file name without traversal.');
    }
  }

  if (input?.sha256 !== undefined && !SHA256_PATTERN.test(String(input.sha256))) {
    reasons.push('sha256 must be a 64-character hex digest.');
  }

  if (input?.sizeBytes !== undefined) {
    if (!Number.isFinite(input.sizeBytes) || input.sizeBytes <= 0) {
      reasons.push('sizeBytes must be a positive number.');
    } else if (input.sizeBytes > MAX_REGISTRY_FILE_BYTES) {
      reasons.push('File is larger than the 40 GB safety limit.');
    }
  }

  const valid = reasons.length === 0;
  return {
    valid,
    reasons,
    normalizedUrl,
    host,
    suggestedProfile: valid ? suggestProfile(repoId, input?.taskKinds) : null,
  };
}
