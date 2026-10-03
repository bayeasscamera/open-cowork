import type { GatewayAuthConfig, GatewayConfig } from './types';

/**
 * Minimum credential length for remote control-plane access. There is no
 * maximum because only exact full-string matches are accepted.
 */
export const MIN_REMOTE_CONTROL_TOKEN_LENGTH = 32;

export type RemoteNetworkExposure = 'loopback' | 'remote';

export class RemoteNetworkAccessError extends Error {
  readonly code = 'remote-control-token-required';

  constructor(message: string) {
    super(message);
    this.name = 'RemoteNetworkAccessError';
  }
}

interface RemoteNetworkSettings {
  bind: GatewayConfig['bind'];
  tunnel?: GatewayConfig['tunnel'];
}

/**
 * A listener is remote when it accepts connections from another host (`0.0.0.0`)
 * or when a configured tunnel can forward an external URL to it. Both paths put
 * bearer credentials and session traffic outside this machine.
 */
export function getRemoteNetworkExposure(settings: RemoteNetworkSettings): RemoteNetworkExposure {
  if (settings.bind !== '127.0.0.1' || settings.tunnel?.enabled === true) {
    return 'remote';
  }
  return 'loopback';
}

/** Normalize a configured credential without exposing which side failed. */
export function getRemoteControlToken(auth: GatewayAuthConfig | undefined): string {
  const token = auth?.remoteControlToken;
  return typeof token === 'string' ? token.trim() : '';
}

/**
 * Credentials accepted for generic remote-control clients. The dedicated
 * control token is preferred because it leaves channel pairing, allowlists and
 * provider-specific authorization unchanged. A legacy mode-wide token remains
 * accepted only when it is configured and long enough to resist guessing.
 */
export function getRemoteControlCredentials(auth: GatewayAuthConfig | undefined): string[] {
  const credentials = [getRemoteControlToken(auth)];
  if (auth?.mode === 'token') {
    const token = typeof auth.token === 'string' ? auth.token.trim() : '';
    if (token) credentials.push(token);
  }
  return [...new Set(credentials)];
}

/**
 * Refuse an unauthenticated or weakly authenticated remote listener before it
 * starts. Channel webhooks still receive their own provider-signature checks;
 * this does not replace those checks. It closes the generic control plane,
 * where no per-channel user identity is available.
 */
export function assertSafeRemoteExposure(config: GatewayConfig): void {
  if (getRemoteNetworkExposure(config) === 'loopback') {
    return;
  }

  const credentials = getRemoteControlCredentials(config.auth).filter(
    (credential) => credential.length > 0
  );
  if (credentials.length === 0) {
    throw new RemoteNetworkAccessError(
      'A remote control token is required before exposing the gateway beyond loopback or enabling a tunnel.'
    );
  }

  const weak = credentials.some((credential) => credential.length < MIN_REMOTE_CONTROL_TOKEN_LENGTH);
  if (weak) {
    throw new RemoteNetworkAccessError(
      `A remote control token must be at least ${MIN_REMOTE_CONTROL_TOKEN_LENGTH} characters.`
    );
  }
}
