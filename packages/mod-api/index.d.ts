/**
 * Public mod API for Open Cowork — v1.
 *
 * This file is TYPES ONLY. It contains no runtime code, so importing from it
 * costs nothing at runtime and needs no build step. Mod authors point their
 * compiler at this file directly; the app resolves the same file through the
 * `@cowork/mod-api` path alias. One contract, two consumers, no drift.
 *
 * Execution model, stated plainly because it is a decision, not a default:
 * a mod runs INSIDE Cowork's main process with the same access Cowork itself
 * has — Node, Electron, filesystem, network, database. `capabilities` in the
 * manifest is DECLARATIVE. It is shown to the user at install time so they know
 * what a mod says it needs; it is NOT enforced, because no in-process boundary
 * could enforce it. Installing a mod means trusting its code.
 *
 * What IS enforced: nothing a mod does through Cowork's own tool pipeline is
 * trusted blindly. `ctx.tools.invoke` goes through `invokeTool()`, so
 * permissions, the path guard and risk assessment still apply, and the
 * approval card shows the FINAL action after every mod has run.
 */

/** Semantic version string. Not validated here — the manifest schema owns that. */
export type ModVersion = string;

/** Where a mod came from. `system` bands run first and are reserved for the app. */
export type ModBand = 'system' | 'org' | 'user';

export type ModId = string;

/**
 * What happens when a mod's hook throws or exceeds its timeout.
 *
 * `open`   — the failure is logged and the call proceeds. The default.
 * `closed` — the call is refused. Only meaningful for security mods, where
 *            failing to evaluate must not mean "allow".
 */
export type ModFailMode = 'open' | 'closed';

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export interface ModFsCapability {
  /** Paths or `${workspace}` placeholders. Informational only. */
  readonly read?: readonly string[];
  readonly write?: readonly string[];
}

export interface ModNetworkCapability {
  /** Hostnames. Informational only. */
  readonly domains?: readonly string[];
}

/**
 * Slots a mod may contribute to. Declarative: the host does not restrict a mod
 * from rendering elsewhere, but anything it declares is shown at install time.
 */
export type ModUiSlot = 'statusBar' | 'messageActions' | 'sidePanel' | 'settingsTab';

export interface ModCapabilities {
  readonly fs?: ModFsCapability;
  readonly network?: ModNetworkCapability;
  readonly ui?: readonly ModUiSlot[];
  /** Persistent key/value storage via `ctx.storage`. */
  readonly storage?: boolean;
  /** Model calls via `ctx.model.ask`. */
  readonly model?: boolean;
}

/** Manifest as parsed and validated by the host. */
export interface ModManifest {
  readonly id: ModId;
  readonly name: string;
  readonly version: ModVersion;
  /** Manifest schema version. Bumped when the contract changes incompatibly. */
  readonly apiVersion: 1;
  /** Entry module, relative to the plugin root. Must resolve inside the plugin. */
  readonly entry: string;
  readonly band: ModBand;
  readonly failMode: ModFailMode;
  /** Events the mod subscribes to. Informational; the real contract is its code. */
  readonly events?: readonly ModEventName[];
  readonly capabilities?: ModCapabilities;
  readonly author?: string;
  readonly homepage?: string;
}

// ---------------------------------------------------------------------------
// Hook payloads and decisions
// ---------------------------------------------------------------------------

export interface ModSessionInfo {
  readonly sessionId: string;
  readonly projectId?: string;
  readonly cwd: string;
  readonly modelId?: string;
}

export interface ModToolCall {
  readonly sessionId: string;
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface ModToolResult {
  /** Concatenated text content of the result. */
  readonly content: string;
}

export interface ModContextSection {
  readonly title: string;
  readonly body: string;
}

/**
 * A user prompt decision.
 *
 * `rewrite` REPLACES the prompt. `block` refuses it. `continue` is a no-op.
 * There is deliberately no "approve" variant: a mod cannot answer on the user's
 * behalf.
 */
export type UserPromptDecision =
  | { readonly action: 'continue' }
  | { readonly action: 'rewrite'; readonly prompt: string }
  | { readonly action: 'block'; readonly reason: string };

export type ContextBuildDecision =
  | { readonly action: 'continue' }
  | { readonly action: 'add'; readonly section: ModContextSection };

/**
 * A pre-tool-use decision.
 *
 * `ask` re-runs the normal permission flow — it does NOT grant it. A mod cannot
 * turn a dangerous or suspicious action into an allowed one; the host's risk
 * assessment and the user's approval card still run AFTER every mod.
 */
export type PreToolUseDecision =
  | { readonly action: 'allow' }
  | { readonly action: 'deny'; readonly reason: string }
  | { readonly action: 'rewrite'; readonly args: Record<string, unknown> }
  | { readonly action: 'ask'; readonly reason?: string };

/**
 * A permission decision.
 *
 * `deny` only. There is intentionally no `allow`: a mod must never be able to
 * approve an action, dangerous or not. Deferring to the host is the only other
 * legal answer.
 */
export type PermissionDecision =
  | { readonly action: 'defer' }
  | { readonly action: 'deny'; readonly reason: string };

export type PostToolUseDecision =
  | { readonly action: 'continue' }
  | { readonly action: 'rewrite'; readonly content: string };

export type AssistantMessageDecision =
  | { readonly action: 'continue' }
  | { readonly action: 'annotate'; readonly annotation: string };

export type CompactDecision =
  | { readonly action: 'continue' }
  | { readonly action: 'annotate'; readonly note: string };

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Room events (multi-agent rooms). Observational: a mod cannot act for an agent. */
export interface ModRoomEventPayload {
  readonly roomId: string;
  readonly kind: 'message' | 'claim' | 'handoff' | 'result' | 'question' | 'decision' | 'agent_status';
  readonly author: string;
  readonly body?: string;
}

/**
 * The event map. Key is the event name, value is `[payload, decision?]`.
 *
 * `onRoomEvent` is part of this contract so a mod written against v1 keeps
 * compiling when rooms ship.
 */
export interface ModEventMap {
  onSessionStart: { payload: ModSessionInfo; decision: undefined };
  onSessionEnd: { payload: ModSessionInfo; decision: undefined };
  onUserPrompt: {
    payload: { readonly prompt: string; readonly session: ModSessionInfo };
    decision: UserPromptDecision;
  };
  onContextBuild: {
    payload: { readonly cwd: string; readonly sections: readonly ModContextSection[] };
    decision: ContextBuildDecision;
  };
  onPreToolUse: { payload: ModToolCall; decision: PreToolUseDecision };
  onPermissionRequest: {
    payload: ModToolCall & { readonly risk?: string; readonly sensitive?: boolean };
    decision: PermissionDecision;
  };
  onPostToolUse: { payload: ModToolCall & { readonly result: ModToolResult }; decision: PostToolUseDecision };
  onAssistantMessage: {
    payload: { readonly text: string; readonly session: ModSessionInfo };
    decision: AssistantMessageDecision;
  };
  onCompact: { payload: { readonly session: ModSessionInfo }; decision: CompactDecision };
  onRoomEvent: { payload: ModRoomEventPayload; decision: undefined };
}

export type ModEventName = keyof ModEventMap;

// ---------------------------------------------------------------------------
// UI contribution
// ---------------------------------------------------------------------------

/**
 * Declarative UI. The host renders these with its own components, so a mod
 * cannot ship raw HTML into the main renderer and inherit the app's design
 * system (or its XSS surface).
 */
export type ModUiNode =
  | { readonly kind: 'text'; readonly label: string }
  | { readonly kind: 'button'; readonly id: string; readonly label: string; readonly variant?: 'primary' | 'ghost' }
  | { readonly kind: 'list'; readonly id: string; readonly items: readonly { readonly label: string; readonly value?: string }[] }
  | { readonly kind: 'table'; readonly id: string; readonly columns: readonly string[]; readonly rows: readonly (readonly string[])[] }
  | { readonly kind: 'form'; readonly id: string; readonly fields: readonly { readonly id: string; readonly label: string }[] };

export interface ModUiContribution {
  readonly slot: ModUiSlot;
  readonly nodes: readonly ModUiNode[];
}

// ---------------------------------------------------------------------------
// Host services available to a mod
// ---------------------------------------------------------------------------

export interface ModLog {
  debug(message: string, ...rest: unknown[]): void;
  info(message: string, ...rest: unknown[]): void;
  warn(message: string, ...rest: unknown[]): void;
  error(message: string, ...rest: unknown[]): void;
}

export interface ModStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  /** Keys in the current scope. */
  list(): Promise<string[]>;
  /** Bytes used, for the UI's "stored data" indicator. */
  usage(): Promise<number>;
}

export interface ModSettings {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set<T = unknown>(key: string, value: T): Promise<void>;
}

export interface ModSessionView {
  readonly id: string;
  readonly projectId?: string;
  readonly cwd: string;
  readonly createdAt?: string;
}

export interface ModFsHelper {
  readFile(path: string): Promise<string>;
  listDir(path: string): Promise<readonly string[]>;
  exists(path: string): Promise<boolean>;
}

export interface ModToolResultEnvelope {
  readonly content: string;
  readonly isError?: boolean;
}

/**
 * Invoking a Cowork tool. THIS IS THE RECOMMENDED PATH: it re-enters
 * `invokeTool()`, so preset allow-list, permissions, path guard and risk
 * assessment all still apply, and the approval card names the mod that asked.
 */
export interface ModToolsApi {
  invoke(toolName: string, args: Record<string, unknown>): Promise<ModToolResultEnvelope>;
}

export interface ModModelAskOptions {
  /** Hard cap in USD. The host enforces it, not the mod. */
  readonly maxCostUsd?: number;
  readonly timeoutMs?: number;
}

export interface ModModelApi {
  /** The model's reply is DATA, never an instruction for the host. */
  ask(prompt: string, options?: ModModelAskOptions): Promise<string>;
}

export interface ModUiApi {
  /** Contribute declarative UI to a slot. Rendered by the host. */
  contribute(contribution: ModUiContribution): Promise<void>;
  /** Show a non-blocking notice. */
  notify(message: string, level?: 'info' | 'warn' | 'error'): Promise<void>;
  /** Read back a value the user submitted through a contributed form. */
  readValue(nodeId: string): Promise<unknown>;
}

/**
 * Practical helpers. NOT a security boundary — a mod can `import('node:fs')`
 * and get the same access regardless. The reason to prefer these is that tool
 * calls made through `tools.invoke` stay inside the approval pipeline.
 */
export interface ModContext {
  readonly modId: ModId;
  readonly manifest: ModManifest;
  readonly log: ModLog;
  readonly storage: ModStorage;
  readonly settings: ModSettings;
  /** Read-only view of the session. */
  readonly session: ModSessionView;
  readonly fs: ModFsHelper;
  readonly tools: ModToolsApi;
  readonly model: ModModelApi;
  readonly ui: ModUiApi;
}

/** A loaded mod: its manifest, its context, and the hooks it actually defines. */
export interface CoworkModV2 {
  /** Mirrors the manifest id; the host checks they agree. */
  readonly id: ModId;
  onSessionStart?(info: ModSessionInfo): void | Promise<void>;
  onSessionEnd?(info: ModSessionInfo): void | Promise<void>;
  onUserPrompt?(input: { prompt: string; session: ModSessionInfo }): UserPromptDecision | void | Promise<UserPromptDecision | void>;
  onContextBuild?(input: { cwd: string; sections: ModContextSection[] }): ContextBuildDecision | void | Promise<ContextBuildDecision | void>;
  onPreToolUse?(call: ModToolCall): PreToolUseDecision | void | Promise<PreToolUseDecision | void>;
  onPermissionRequest?(call: ModToolCall & { risk?: string; sensitive?: boolean }): PermissionDecision | void | Promise<PermissionDecision | void>;
  onPostToolUse?(call: ModToolCall, result: ModToolResult): PostToolUseDecision | void | Promise<PostToolUseDecision | void>;
  onAssistantMessage?(input: { text: string; session: ModSessionInfo }): AssistantMessageDecision | void | Promise<AssistantMessageDecision | void>;
  onCompact?(input: { session: ModSessionInfo }): CompactDecision | void | Promise<CompactDecision | void>;
  onRoomEvent?(event: ModRoomEventPayload): void | Promise<void>;
}

/** What a mod module exports by default (or named `activate`). */
export type CoworkModV2Module = CoworkModV2 & { activate?: (ctx: ModContext) => CoworkModV2 | void };

/** Host-side record of a loaded mod, including its health. */
export interface ModHealth {
  readonly failures: number;
  readonly disabled: boolean;
  readonly disabledReason?: string;
  readonly lastError?: string;
  readonly lastDurationMs?: number;
}

export interface LoadedMod {
  readonly manifest: ModManifest;
  readonly mod: CoworkModV2;
  readonly health: ModHealth;
}