/**
 * @module main/agent/model-router
 * v3.5: Dynamic Fallback and Multi-Provider Routing
 */

export interface ModelEndpoint {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  priority: number;
}

export interface RouteExecutionResult<T> {
  result: T;
  usedEndpoint: ModelEndpoint;
  fallbacksAttempted: number;
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
    operation: (endpoint: ModelEndpoint) => Promise<T>
  ): Promise<RouteExecutionResult<T>> {
    let lastError: unknown = null;
    let attempts = 0;

    for (const endpoint of this.endpoints) {
      try {
        attempts++;
        const result = await operation(endpoint);
        return {
          result,
          usedEndpoint: endpoint,
          fallbacksAttempted: attempts - 1,
        };
      } catch (err: unknown) {
        lastError = err;
        const code = (err as { code?: string })?.code;
        const status = (err as { status?: number })?.status;
        const statusCode = (err as { statusCode?: number })?.statusCode;
        const isRateLimitOrServerError =
          status === 429 ||
          statusCode === 429 ||
          (status !== undefined && status >= 500 && status < 600) ||
          (statusCode !== undefined && statusCode >= 500 && statusCode < 600) ||
          code === 'ECONNRESET' ||
          code === 'ETIMEDOUT';

        if (!isRateLimitOrServerError && attempts < this.endpoints.length) {
          // If not network or quota failure, rethrow unless backup endpoints exist
          continue;
        }
      }
    }

    throw new Error(
      `Toutes les tentatives d'exécution de modèle ont échoué (${attempts} routes testées). Dernier message: ${lastError instanceof Error ? lastError.message : String(lastError)}`
    );
  }
}
