/**
 * @module shared/thinking-extractor
 * v3.5: Support extraction & streaming for reasoning models (DeepSeek-R1, Qwen-Max, o-series, Claude 3.7)
 */

export interface ParsedThinkingContent {
  thinking: string;
  response: string;
  isThinkingComplete: boolean;
}

export class StreamingThinkingParser {
  private buffer: string = '';
  private inThinkingBlock: boolean = false;
  private thinkingAccumulator: string = '';
  private responseAccumulator: string = '';

  /**
   * Process a chunk of text streamed from the LLM
   */
  public pushChunk(chunk: string): { thinkingChunk: string; responseChunk: string } {
    this.buffer += chunk;
    let thinkingChunk = '';
    let responseChunk = '';

    while (this.buffer.length > 0) {
      if (!this.inThinkingBlock) {
        const startTagIndex = this.buffer.indexOf('<think>');
        if (startTagIndex === -1) {
          // Check for partial tag match at the end
          const partialIndex = this.getPartialTagMatch(this.buffer, '<think>');
          if (partialIndex !== -1) {
            responseChunk += this.buffer.slice(0, partialIndex);
            this.responseAccumulator += this.buffer.slice(0, partialIndex);
            this.buffer = this.buffer.slice(partialIndex);
            break;
          } else {
            responseChunk += this.buffer;
            this.responseAccumulator += this.buffer;
            this.buffer = '';
            break;
          }
        } else {
          responseChunk += this.buffer.slice(0, startTagIndex);
          this.responseAccumulator += this.buffer.slice(0, startTagIndex);
          this.inThinkingBlock = true;
          this.buffer = this.buffer.slice(startTagIndex + '<think>'.length);
        }
      } else {
        const endTagIndex = this.buffer.indexOf('</think>');
        if (endTagIndex === -1) {
          const partialIndex = this.getPartialTagMatch(this.buffer, '</think>');
          if (partialIndex !== -1) {
            thinkingChunk += this.buffer.slice(0, partialIndex);
            this.thinkingAccumulator += this.buffer.slice(0, partialIndex);
            this.buffer = this.buffer.slice(partialIndex);
            break;
          } else {
            thinkingChunk += this.buffer;
            this.thinkingAccumulator += this.buffer;
            this.buffer = '';
            break;
          }
        } else {
          thinkingChunk += this.buffer.slice(0, endTagIndex);
          this.thinkingAccumulator += this.buffer.slice(0, endTagIndex);
          this.inThinkingBlock = false;
          this.buffer = this.buffer.slice(endTagIndex + '</think>'.length);
        }
      }
    }

    return { thinkingChunk, responseChunk };
  }

  public getFinalResult(): ParsedThinkingContent {
    return {
      thinking: this.thinkingAccumulator.trim(),
      response: (this.responseAccumulator + this.buffer).trim(),
      isThinkingComplete: !this.inThinkingBlock,
    };
  }

  private getPartialTagMatch(str: string, tag: string): number {
    for (let i = 1; i < tag.length; i++) {
      const sub = tag.slice(0, i);
      if (str.endsWith(sub)) {
        return str.length - sub.length;
      }
    }
    return -1;
  }
}
