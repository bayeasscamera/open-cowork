/**
 * Platform descriptor for the shared VM sandbox agent.
 *
 * The agent runs inside a VM (WSL2 on Windows, Lima on macOS) and is compiled
 * per-platform into self-contained bundles (dist-wsl-agent, dist-lima-agent).
 * Everything that differs between the two harnesses is captured here.
 */
export interface VMAgentPlatform {
  /** Human-readable platform label, e.g. "WSL2" or "Lima VM". */
  label: string;
  /** Log prefix on stderr, e.g. "[WSL-Agent]". */
  logPrefix: string;
  /** Env var name carrying the host-side workspace path, e.g. "WINDOWS_WORKSPACE". */
  hostWorkspaceEnv: string;
  /**
   * Prefix of host-side paths as seen inside the VM ("/mnt/" on WSL2,
   * "/Users/" on Lima). Commands referencing these are containment-checked.
   */
  hostPathPrefix: string;
}
