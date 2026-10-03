/**
 * Classification of how the remote gateway is reachable, and therefore whether
 * traffic on it is encrypted.
 *
 * This is deliberately pure and structural: the main process uses it to ENFORCE
 * the policy, and the renderer uses the same function to DISPLAY it. One
 * implementation means the label in the UI cannot drift from the rule that is
 * actually applied.
 *
 * It lives in shared/ rather than main/remote/ because both processes need it,
 * and it deliberately takes a minimal structural input instead of the full
 * GatewayConfig so it depends on no process-specific type.
 */

/** How the gateway is reached. */
export type RemoteTransport =
  /** Bound to loopback only: traffic never leaves the machine. */
  | 'loopback'
  /** Reached through a tunnel, which terminates TLS at the tunnel provider. */
  | 'tunnel-tls'
  /** Bound to a routable interface and served over HTTPS/WSS from a certificate. */
  | 'lan-tls'
  /** Bound to a routable interface with no tunnel: plain HTTP/WS on the wire. */
  | 'plaintext-lan';

export interface RemoteTransportInput {
  /** Gateway bind address. Only loopback keeps traffic on this machine. */
  bind?: string;
  /** Whether an external tunnel is enabled. */
  tunnelEnabled?: boolean;
  /** Whether the gateway serves HTTPS/WSS from a configured certificate. */
  tlsEnabled?: boolean;
}

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Classify the active transport. A tunnel wins over everything else: when one
 * is enabled the public leg is TLS whatever the local bind or local certificate
 * say. Otherwise a routable bind is encrypted only if the gateway is actually
 * serving HTTPS.
 */
export function classifyRemoteTransport(input: RemoteTransportInput): RemoteTransport {
  if (input.tunnelEnabled === true) return 'tunnel-tls';
  const bind = (input.bind ?? '127.0.0.1').trim();
  if (LOOPBACK_ADDRESSES.has(bind)) return 'loopback';
  return input.tlsEnabled === true ? 'lan-tls' : 'plaintext-lan';
}

/** Whether traffic on this transport is encrypted (or never leaves the host). */
export function isTransportEncrypted(transport: RemoteTransport): boolean {
  return transport !== 'plaintext-lan';
}

/** Whether this transport puts data on a network the user does not control. */
export function isTransportOffHost(transport: RemoteTransport): boolean {
  return transport !== 'loopback';
}

/**
 * Whether the user must explicitly accept an unencrypted network before the
 * gateway may bind to a routable interface without a tunnel.
 *
 * A control token authenticates but does not encrypt: on a plain LAN leg it
 * travels in the clear and any host on the path can read it. Requiring an
 * explicit acknowledgement keeps that risk deliberate instead of silent.
 */
export function requiresInsecureBindingAcknowledgement(transport: RemoteTransport): boolean {
  return transport === 'plaintext-lan';
}