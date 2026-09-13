/**
 * @module main/agent/streaming-response-handler
 * Dedicated Streaming & Chunk Dispatch Module
 *
 * Decoupled from agent-runner.ts to isolate WebSocket / IPC message streaming logic.
 */

import { StreamingThinkingParser } from '../../shared/thinking-extractor';

export interface StreamChunkPayload {
  sessionId: string;
  messageId: string;
  type: 'content' | 'thinking' | 'tool_call' | 'done';
  deltaText: string;
  fullThinking?: string;
  fullContent?: string;
}

export class StreamingResponseHandler {
  private parser: StreamingThinkingParser;
  private sessionId: string;
  private messageId: string;
  private onEmit: (payload: StreamChunkPayload) => void;

  constructor(sessionId: string, messageId: string, onEmit: (payload: StreamChunkPayload) => void) {
    this.sessionId = sessionId;
    this.messageId = messageId;
    this.onEmit = onEmit;
    this.parser = new StreamingThinkingParser();
  }

  public handleRawChunk(rawChunk: string): void {
    const { thinkingChunk, responseChunk } = this.parser.pushChunk(rawChunk);

    if (thinkingChunk.length > 0) {
      this.onEmit({
        sessionId: this.sessionId,
        messageId: this.messageId,
        type: 'thinking',
        deltaText: thinkingChunk,
      });
    }

    if (responseChunk.length > 0) {
      this.onEmit({
        sessionId: this.sessionId,
        messageId: this.messageId,
        type: 'content',
        deltaText: responseChunk,
      });
    }
  }

  public finalize(): { fullThinking: string; fullContent: string } {
    const finalResult = this.parser.getFinalResult();
    this.onEmit({
      sessionId: this.sessionId,
      messageId: this.messageId,
      type: 'done',
      deltaText: '',
      fullThinking: finalResult.thinking,
      fullContent: finalResult.response,
    });

    return {
      fullThinking: finalResult.thinking,
      fullContent: finalResult.response,
    };
  }
}
