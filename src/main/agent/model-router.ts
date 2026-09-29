/**
 * @module main/agent/model-router
 * v3.5: Dynamic Fallback and Multi-Provider Routing
 */

import { shouldFallbackToProvider } from './provider-fallback';
import { classifyForFallback } from './provider-fallback';

interface ModelEndpoint {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  priority: number;
}

interface RouteExecutionResult<T> {
  result: T;
  usedEndpoint: ModelEndpoint;
  fallbacksAttempted: number;
}

/**
 * Read the failure kind from an error. Providers surface it in several shapes
 * (an HTTP status, an SDK `code`, or a message string), so every source is
 * checked before falling back to message classification.
 */
function classifyRouteError(err: unknown): ReturnType<typeof classifyForFallback> {
  const code = (err as { code?: string } | null)?.code;
  const status = (err as { status?: number } | null)?.status;
  const statusCode = (err as { statusCode?: number } | null)?.statusCode;
  const message = err instanceof Error ? err.message : String(err ?? '');

  if (status === 429 || statusCode === 429) {
    return 'rate_limited';
  }
  if (
    (status !== undefined && status >= 500 && status < 600) ||
    (statusCode !== undefined && statusCode >= 500 && statusCode < 600)
  ) {
    return 'server_error';
  }
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNREFUSED') {
    return 'network_error';
  }
  return classifyForFallback(message);
}

export class DynamicModelRouter {
  private endpoints: ModelEndpoint[] = [];

  constructor(endpoints: ModelEndpoint[] = []) {
    this.endpoints = [...endpoints].sort((a, b) => a.priority - b.priority);
  }

  public registerEndpoint(endpoint: ModelEndpoint) {
    this.endpoints.push(endpoint);
    this.endpoints.sort((a, b) => a.priority - b.priority);
  }

  public async executeWithFallback<T>(
    operation: (endpoint: ModelEndpoint) => Promise<T>,
    options: { toolExecutions?: number } = {}
  ): Promise<RouteExecutionResult<T>> {
    let lastError: unknown = null;
    let attempts = 0;

    for (const endpoint of this.endpoints) {
      attempts++;
      try {
        const result = await operation(endpoint);
        return { result, usedEndpoint: endpoint, fallbacksAttempted: attempts - 1 };
      } catch (err: unknown) {
        lastError = err;
        // A rate limit, a gateway 5xx and a dropped connection are all worth a
        // retry on the next endpoint. Anything else (auth, bad request, a
        // context overflow) would fail identically everywhere, so the loop ends
        // and the original error reaches the user intact.
        const isLast = attempts >= this.endpoints.length;
        if (
          isLast ||
          !shouldFallbackToProvider({
            errorCode: classifyRouteError(err),
            toolExecutions: options.toolExecutions ?? 0,
          })
        ) {
          break;
        }
      }
    }

    throw new Error(
      `Toutes les tentatives d'exécution de modèle ont échoué (${attempts} routes testées). Dernier message: ${lastError instanceof Error ? lastError.message : String(lastError)}`
    );
  }
}
