import type { ApiTestInput, ApiTestResult } from '../../shared/types';
import type { AppConfig } from './config-store';
import { probeWithSdk } from '../agent/sdk-one-shot';

export async function runConfigApiTest(
  payload: ApiTestInput,
  config: AppConfig
): Promise<ApiTestResult> {
  return probeWithSdk(payload, config);
}
