import type { ChatTransport, ContentBlock, MessageResponse, SendOptions } from './client';

/**
 * Scriptable stand-in for the Anthropic API, in the same spirit as
 * `fakeGraph` and `fakeGoogle`: the conversation loop is the thing worth
 * testing, and it should be testable without a key, a network or a bill.
 *
 * A script is a list of replies, returned one per request, so a multi-step
 * tool chain is expressed as several entries. Every request is recorded so a
 * test can assert on what the model was actually told.
 */
export class FakeClaudeTransport implements ChatTransport {
  private queue: MessageResponse[] = [];
  readonly requests: SendOptions[] = [];
  /** Set to make the next send reject, for error-path coverage. */
  failWith: string | null = null;

  /** Queue a plain text reply that ends the turn. */
  say(text: string): this {
    return this.push([{ type: 'text', text }], 'end_turn');
  }

  /** Queue a reply that calls one tool and waits for its result. */
  callTool(name: string, input: Record<string, unknown>, id = `tu_${this.queue.length + 1}`): this {
    return this.push([{ type: 'tool_use', id, name, input }], 'tool_use');
  }

  /** Queue a reply that calls several tools in one turn. */
  callTools(calls: { name: string; input: Record<string, unknown> }[]): this {
    return this.push(
      calls.map((c, i) => ({ type: 'tool_use' as const, id: `tu_${i}`, ...c })),
      'tool_use',
    );
  }

  push(content: ContentBlock[], stop_reason: string): this {
    this.queue.push({ content, stop_reason });
    return this;
  }

  async send(options: SendOptions): Promise<MessageResponse> {
    this.requests.push(options);
    if (this.failWith) {
      const message = this.failWith;
      this.failWith = null;
      throw new Error(message);
    }
    const next = this.queue.shift();
    if (!next) throw new Error('FakeClaudeTransport ran out of scripted replies');
    return next;
  }

  /** The tool_result blocks sent back on the most recent request. */
  lastToolResults(): { tool_use_id: string; content: string; is_error?: boolean }[] {
    const last = this.requests.at(-1);
    if (!last) return [];
    const results: { tool_use_id: string; content: string; is_error?: boolean }[] = [];
    for (const message of last.messages) {
      if (typeof message.content === 'string') continue;
      for (const block of message.content) {
        if (block.type === 'tool_result') {
          results.push({
            tool_use_id: block.tool_use_id,
            content: block.content,
            is_error: block.is_error,
          });
        }
      }
    }
    return results;
  }
}
