#!/usr/bin/env node
/**
 * WSL2 entry point — compiles standalone into dist-wsl-agent/index.js,
 * self-contained for execution inside WSL2.
 */

import { runAgent } from '../agent';
import type { VMAgentPlatform } from '../platform';

const PLATFORM: VMAgentPlatform = {
  label: 'WSL2',
  logPrefix: '[WSL-Agent]',
  hostWorkspaceEnv: 'WINDOWS_WORKSPACE',
  hostPathPrefix: '/mnt/',
};

runAgent(PLATFORM).catch((error: unknown) => {
  console.error('Failed to start WSL agent:', error);
  process.exit(1);
});
