/**
 * @module main/agent/session-event-handler
 *
 * Handles every pi session stream event except logging: assistant text/thinking
 * deltas, the unified message_end path (content blocks, loop guard, usage), tool
 * execution traces and auto-compaction steps.
 *
 * Extracted from the piSession.subscribe() callback in CoworkAgentRunner.run().
 * The abort guard, the activity-timeout reset and the callback's try/catch stay
 * in the runner; this module receives every effect and every piece of mutable
 * runner state through an injected context, so it owns no singleton.
 */

import type { AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import { v4 as uuidv4 } from 'uuid';
import type { ContentBlock, Message, ServerEvent, TraceStep } from '../../shared/types';
import { log, logCtx, logCtxError } from '../utils/logger';
import { buildArtifactTraceSteps, extractArtifactsFromText } from '../utils/artifact-parser';
import { normalizeTokenUsage, safeStringify } from './agent-runner-formatting';
import {
  resolveAssistantStreamErrorText,
  resolveMessageEndPayload,
} from './agent-runner-message-end';
import type { LoopGuard, LoopGuardDecision, ToolCallDescriptor } from './agent-runner-loop-guard';
import { normalizeToolExecutionResultForUi } from './tool-result-utils';
import { quarantineRawProtocolMarkup } from '../../shared/raw-protocol-markup';

/** Mutable runner state the handler reads and writes through accessors. */
export interface PiSessionEventState {
  getStreamedText(): string;
  setStreamedText(text: string): void;
  isTwoStageArmed(): boolean;
  stashPipelineDraft(message: Message, text: string): void;
  getCompactionStepId(): string | undefined;
  setCompactionStepId(id: string | undefined): void;
}

/** Minimal telemetry surface (satisfied by StreamLivenessWatcher). */
export interface PiSessionEventTelemetry {
  markFirstStreamEvent(eventType: string): void;
  hasReceivedFirstStreamEvent(): boolean;
  getFirstStreamLatencyMs(): number | null;
  /**
   * A tool started/finished. Optional so a telemetry double that does not track
   * tools (tests, diagnostics) stays valid.
   */
  beginToolCall?(toolName?: string): void;
  endToolCall?(): void;
}

/**
 * Phase 6 control center bridge: the runner records the tool lifecycle in the
 * activity feed. Optional so the handler stays usable without a control center.
 */
export interface PiSessionToolActivity {
  start(input: { toolCallId: string; toolName: string; label: string; args?: unknown }): void;
  end(input: { toolCallId: string; toolName: string; isError: boolean; output?: string }): void;
}

/** Detail passed to PiSessionEventContext.reportProtocolLeak (kept separate so the contract test's single-line interface extraction stays accurate). */
export interface ProtocolLeakDetail {
  sessionId: string;
  fragmentCount: number;
  sample: string;
}

/** Everything the handler needs from the runner; no implicit singleton. */
export interface PiSessionEventContext {
  sessionId: string;
  provider: string;
  model: { id: string; provider?: string; api?: string };
  usedSyntheticModel: boolean;
  isAborted(): boolean;
  telemetry: PiSessionEventTelemetry;
  loopGuard: LoopGuard;
  handleLoopGuardDecision(decision: LoopGuardDecision, context: string): void;
  state: PiSessionEventState;
  sendPartial(delta: string): void;
  sendToRenderer(event: ServerEvent): void;
  sendTraceStep(step: TraceStep): void;
  sendTraceUpdate(stepId: string, updates: Partial<TraceStep>): void;
  sendMessage(message: Message): void;
  getToolDisplayName(toolName: string): string;
  emitTerminalError(errorText: string, options?: { abort?: boolean }): void;
  sanitizeOutputPaths(content: string): string;
  /** Records tool executions in the control center activity feed. */
  toolActivity?: PiSessionToolActivity;
  /**
   * Reports that an assistant text block carried raw agent-protocol markup
   * (tool_use/turn tags leaked as plain text). Optional so the handler stays
   * usable in tests. Used for telemetry and causal error-pattern memory; the
   * persisted message content is deliberately left untouched.
   */
  reportProtocolLeak?(detail: ProtocolLeakDetail): void;
}

/** Bridges agent SDK session events to the Open Cowork ServerEvent protocol. */
export function handlePiSessionEvent(event: AgentSessionEvent, ctx: PiSessionEventContext): void {
  switch (event.type) {
    case 'message_update': {
      if (ctx.isAborted()) break;
      const ame = event.assistantMessageEvent;
      if (ame.type === 'text_delta') {
        ctx.telemetry.markFirstStreamEvent(ame.type);
        ctx.state.setStreamedText(ctx.state.getStreamedText() + ame.delta);
        // Two-stage draft: the first pass is never presented as the
        // answer, so its live stream is withheld. The accumulated text
        // still drives the refine decision after the run.
        if (!ctx.state.isTwoStageArmed()) ctx.sendPartial(ame.delta);
      } else if (ame.type === 'thinking_delta') {
        ctx.telemetry.markFirstStreamEvent(ame.type);
        // Forward thinking delta to renderer for real-time display
        if (!ctx.state.isTwoStageArmed()) {
          ctx.sendToRenderer({
            type: 'stream.thinking',
            payload: { sessionId: ctx.sessionId, delta: ame.delta },
          });
        }
      } else if (ame.type === 'toolcall_start') {
        ctx.telemetry.markFirstStreamEvent(ame.type);
        const partial = ame.partial;
        const toolContent = partial?.content?.[ame.contentIndex];
        const toolName = toolContent?.type === 'toolCall' ? toolContent.name : 'unknown';
        const toolCallId = toolContent?.type === 'toolCall' ? toolContent.id : uuidv4();
        const toolDisplayName = ctx.getToolDisplayName(toolName);
        ctx.sendTraceStep({
          id: toolCallId,
          type: 'tool_call',
          status: 'running',
          title: toolDisplayName,
          toolName,
          toolInput:
            toolContent?.type === 'toolCall'
              ? (toolContent.arguments as Record<string, unknown>) || {}
              : undefined,
          timestamp: Date.now(),
        });
      } else if (ame.type === 'done') {
        // Some providers emit 'done' via message_update — we handle it
        // in message_end below as a unified path for all providers.
        log('[CoworkAgentRunner] message_update done event (handled in message_end)');
      } else if (ame.type === 'error') {
        ctx.telemetry.markFirstStreamEvent(ame.type);
        const errorDetail = JSON.stringify(ame.error?.content || 'no content');
        logCtxError('[CoworkAgentRunner] pi-ai stream error:', ame.reason, errorDetail);
        ctx.emitTerminalError(resolveAssistantStreamErrorText(ame), { abort: true });
      }
      break;
    }

    case 'message_end': {
      // Unified handler: send the final assistant message to the renderer.
      // Works for all providers (some emit 'done' via message_update, others don't).
      if (ctx.isAborted()) break;

      const msg = event.message;
      if (process.env.COWORK_LOG_SDK_MESSAGES_FULL === '1') {
        log('[CoworkAgentRunner] message_end raw message:', safeStringify(msg, 2));
      }
      const resolvedPayload = resolveMessageEndPayload({
        message: msg as Parameters<typeof resolveMessageEndPayload>[0]['message'],
        streamedText: ctx.state.getStreamedText(),
      });
      ctx.state.setStreamedText(resolvedPayload.nextStreamedText);
      if (ctx.provider === 'ollama') {
        log(
          '[CoworkAgentRunner] Ollama message_end diagnostics',
          safeStringify({
            sessionId: ctx.sessionId,
            modelId: ctx.model.id,
            modelProvider: ctx.model.provider,
            usedSyntheticModel: ctx.usedSyntheticModel,
            receivedFirstStreamEvent: ctx.telemetry.hasReceivedFirstStreamEvent(),
            firstStreamLatencyMs: ctx.telemetry.getFirstStreamLatencyMs(),
            stopReason: (msg as { stopReason?: unknown })?.stopReason ?? null,
            contentBlocks: Array.isArray((msg as { content?: unknown[] })?.content)
              ? ((msg as { content?: unknown[] }).content?.length ?? 0)
              : 0,
            emittedError: Boolean(resolvedPayload.errorText),
          })
        );
      }
      if (resolvedPayload.errorText) {
        ctx.emitTerminalError(resolvedPayload.errorText);
        break;
      }
      if (resolvedPayload.shouldEmitMessage) {
        const contentBlocks: ContentBlock[] = [];
        for (const block of resolvedPayload.effectiveContent) {
          if (block.type === 'text') {
            const { cleanText, artifacts } = extractArtifactsFromText(block.text);
            if (cleanText) {
              contentBlocks.push({ type: 'text', text: ctx.sanitizeOutputPaths(cleanText) });
            }
            // Telemetry: raw agent-protocol markup in a text block means the
            // model is leaking its function-calling protocol as plain text
            // (observed with degraded relays). The stored message content is
            // deliberately untouched — the renderer quarantines it for
            // display and cold-start strips it before model replay.
            const protocolLeak = quarantineRawProtocolMarkup(cleanText);
            if (protocolLeak.fragments.length > 0) {
              ctx.reportProtocolLeak?.({
                sessionId: ctx.sessionId,
                fragmentCount: protocolLeak.fragments.length,
                sample: protocolLeak.fragments[0]?.slice(0, 120) ?? '',
              });
            }
            if (artifacts.length > 0) {
              for (const step of buildArtifactTraceSteps(artifacts)) {
                ctx.sendTraceStep(step);
              }
            }
          } else if (block.type === 'toolCall') {
            const displayName = ctx.getToolDisplayName(block.name);
            contentBlocks.push({
              type: 'tool_use',
              id: block.id,
              name: block.name,
              displayName,
              input: block.arguments,
            });
          } else if (block.type === 'thinking') {
            // Include thinking blocks in the final message for UI display
            contentBlocks.push({
              type: 'thinking',
              thinking: block.thinking,
            });
          } else {
            // Unknown block type — pass through as text so content isn't silently lost
            const unknownBlock = block as { type?: string; text?: string };
            log(`[CoworkAgentRunner] Unknown content block type: ${unknownBlock.type}`);
            // safeStringify: an unexpected block must never throw on odd
            // shapes (e.g. circular refs from third-party payloads).
            const text = unknownBlock.text || safeStringify(block);
            if (text) contentBlocks.push({ type: 'text', text });
          }
        }
        // Always clear partial text; send message even if only artifacts were extracted
        ctx.sendToRenderer({
          type: 'stream.partial',
          payload: { sessionId: ctx.sessionId, delta: '' },
        });

        // ── Loop guard layer 1: hash of this message's tool-call group ──
        const toolUseDescriptors: ToolCallDescriptor[] = [];
        for (const block of resolvedPayload.effectiveContent) {
          if (block.type === 'toolCall') {
            toolUseDescriptors.push({
              name: block.name || '',
              input: (block.arguments as Record<string, unknown>) || undefined,
            });
          }
        }
        if (toolUseDescriptors.length > 0) {
          ctx.handleLoopGuardDecision(
            ctx.loopGuard.recordAssistantMessage(toolUseDescriptors),
            'message_end'
          );
          if (ctx.isAborted()) break;
        }

        if (contentBlocks.length > 0) {
          const msgWithUsage = msg as { usage?: unknown };
          const tokenUsage = normalizeTokenUsage(msgWithUsage.usage);
          if (msgWithUsage.usage) {
            log(
              '[CoworkAgentRunner] normalized usage:',
              safeStringify(
                {
                  raw: msgWithUsage.usage,
                  normalized: tokenUsage,
                },
                2
              )
            );
          }
          const assistantMsg: Message = {
            id: uuidv4(),
            sessionId: ctx.sessionId,
            role: 'assistant',
            content: contentBlocks,
            timestamp: Date.now(),
            api: ctx.model.api,
            provider: ctx.model.provider,
            model: ctx.model.id,
            tokenUsage,
          };
          // Two-stage draft: withhold the terminal text-only answer so
          // it is never presented as the final answer. It is kept in
          // memory and then either released as-is (pipeline skipped or
          // refine failed) or replaced by the refined version. Tool-call
          // messages still flow through untouched so tools render live.
          const isTerminalTextOnly =
            !contentBlocks.some((block) => block.type === 'tool_use') &&
            contentBlocks.some((block) => block.type === 'text');
          if (ctx.state.isTwoStageArmed() && isTerminalTextOnly) {
            const draftText = contentBlocks
              .filter((block) => block.type === 'text')
              .map((block) =>
                'text' in block ? quarantineRawProtocolMarkup(block.text).cleanText : ''
              )
              .join('\n\n')
              .trim();
            ctx.state.stashPipelineDraft(assistantMsg, draftText);
            break;
          }
          ctx.sendMessage(assistantMsg);
        }
      }
      break;
    }

    case 'tool_execution_start': {
      logCtx(`[CoworkAgentRunner] Tool execution start: ${event.toolName}`);
      // The SDK is now silent for the whole execution, so the inactivity
      // countdown must be suspended — otherwise a long build is mistaken for a
      // dead stream and the run is aborted mid-work.
      ctx.telemetry.beginToolCall?.(event.toolName);
      // ── Loop guard layer 2: per-tool cumulative frequency ──
      ctx.handleLoopGuardDecision(
        ctx.loopGuard.recordToolInvocation(event.toolName),
        'tool_execution_start'
      );
      ctx.toolActivity?.start({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        label: ctx.getToolDisplayName(event.toolName),
        args: event.args,
      });
      break;
    }

    case 'tool_execution_end': {
      // Re-arm BEFORE the early return: an aborted run still must not leave a
      // phantom tool in flight, and dispose() follows either way.
      ctx.telemetry.endToolCall?.();
      if (ctx.isAborted()) break;
      const toolCallId = event.toolCallId;
      const isError = event.isError;
      const normalizedToolResult = normalizeToolExecutionResultForUi(event.result);
      const outputText = normalizedToolResult.content;
      const toolDisplayName = ctx.getToolDisplayName(event.toolName);
      ctx.toolActivity?.end({
        toolCallId,
        toolName: event.toolName,
        isError,
        output: outputText,
      });
      ctx.sendTraceUpdate(toolCallId, {
        status: isError ? 'error' : 'completed',
        title: toolDisplayName,
        toolName: event.toolName,
        toolOutput: ctx.sanitizeOutputPaths(outputText).slice(0, 800),
      });

      // Send tool result message
      const toolResultMsg: Message = {
        id: uuidv4(),
        sessionId: ctx.sessionId,
        role: 'assistant',
        content: [
          {
            type: 'tool_result',
            toolUseId: toolCallId,
            content: ctx.sanitizeOutputPaths(outputText),
            isError,
            ...(normalizedToolResult.images.length > 0
              ? { images: normalizedToolResult.images }
              : {}),
          },
        ],
        timestamp: Date.now(),
      };
      ctx.sendMessage(toolResultMsg);
      break;
    }

    case 'agent_end': {
      logCtx('[CoworkAgentRunner] Agent finished');
      break;
    }

    case 'auto_compaction_start': {
      log('[CoworkAgentRunner] Auto-compaction started, reason:', event.reason);
      const compactionStepId = `compaction-${Date.now()}`;
      ctx.state.setCompactionStepId(compactionStepId);
      ctx.sendTraceStep({
        id: compactionStepId,
        type: 'thinking',
        status: 'running',
        title: `Compacting context (${event.reason})...`,
        timestamp: Date.now(),
      });
      break;
    }

    case 'auto_compaction_end': {
      const compactionStepId = ctx.state.getCompactionStepId();
      const status = event.aborted ? 'error' : event.errorMessage ? 'error' : 'completed';
      const title = event.aborted
        ? 'Context compaction aborted'
        : event.errorMessage
          ? `Context compaction failed: ${event.errorMessage}`
          : 'Context compaction completed';
      log('[CoworkAgentRunner] Auto-compaction ended:', title, 'willRetry:', event.willRetry);

      // Surface compaction result details to the renderer (skip if retrying)
      if (event.result && !event.willRetry) {
        const compactionDetails = event.result.details as
          | { readFiles?: string[]; modifiedFiles?: string[] }
          | undefined;
        ctx.sendToRenderer({
          type: 'compaction.result',
          payload: {
            sessionId: ctx.sessionId,
            summary: event.result.summary,
            tokensBefore: event.result.tokensBefore,
            readFiles: compactionDetails?.readFiles || [],
            modifiedFiles: compactionDetails?.modifiedFiles || [],
          },
        });
        log(
          '[CoworkAgentRunner] Compaction result surfaced:',
          JSON.stringify({
            summaryLen: event.result.summary.length,
            tokensBefore: event.result.tokensBefore,
            readFiles: compactionDetails?.readFiles?.length || 0,
            modifiedFiles: compactionDetails?.modifiedFiles?.length || 0,
          })
        );
      }

      if (compactionStepId) {
        ctx.sendTraceUpdate(compactionStepId, { status, title });
        ctx.state.setCompactionStepId(undefined);
      } else {
        // Fallback: no matching start event, send as new step
        ctx.sendTraceStep({
          id: `compaction-end-${Date.now()}`,
          type: 'thinking',
          status,
          title,
          timestamp: Date.now(),
        });
      }
      break;
    }
  }
}
