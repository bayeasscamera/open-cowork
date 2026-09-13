#!/usr/bin/env node
/**
 * Lima entry point — compiles standalone into dist-lima-agent/index.js,
 * self-contained for execution inside the Lima VM.
 */

import { runAgent } from '../agent';
import type { VMAgentPlatform } from '../platform';

const PLATFORM: VMAgentPlatform = {
  label: 'Lima VM',
  logPrefix: '[Lima-Agent]',
  hostWorkspaceEnv: 'MAC_WORKSPACE',
  hostPathPrefix: '/Users/',
};

runAgent(PLATFORM).catch((error: unknown) => {
  console.error('Failed to start Lima agent:', error);
  process.exit(1);
});
