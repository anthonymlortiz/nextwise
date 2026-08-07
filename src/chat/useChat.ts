import { useCallback, useRef, useState } from 'react';
import type { ApiMessage, ChatTransport, ContentBlock, ToolUseBlock } from './client';
import { DEFAULT_MODEL, httpTransport } from './client';
import { TOOL_SCHEMAS, executeTool, type ToolDeps } from './tools';

/**
 * A turn as the user sees it. This is deliberately not the same shape as the
 * wire format: the transcript needs tool activity rendered as its own visible
 * step, because an assistant that silently edits the board is one the user
 * cannot audit.
 */
export interface ChatEntry {
  id: number;
  role: 'user' | 'assistant' | 'tool' | 'error';
  text: string;
  /** Set on tool entries, for the compact "ran list_tasks" line. */
  toolName?: string;
  failed?: boolean;
}

/**
 * The model can chain tools — find a task, then update it — so a single user
 * message may need several round trips. This caps them: a loop that cannot
 * terminate is otherwise billed to the user one request at a time.
 */
const MAX_STEPS = 8;

const SYSTEM = `You are jAIme, the assistant inside Nextwise, a personal productivity app.

Nextwise splits everything into two areas, work and personal, and groups tasks into
projects inside those areas. Every task carries a priority (P1 critical to P4 low), an
estimated duration in minutes, and a focus level (deep, medium or shallow) describing how
much concentration it needs.

Your job is to help the user decide what to work on and to keep the board tidy, in as few
words as possible. Be direct and concrete. You are talking to someone who wants to start
working, not to read.

Rules:
- When asked what to work on, ALWAYS call the recommend tool. Never rank tasks yourself.
  The app has a scoring engine and its answer is the correct one; your job is to relay it
  and explain it in a sentence, not to second-guess it.
- When the user mentions their situation ("I have half an hour", "I'm exhausted"), call
  set_context so the rest of the app agrees with the conversation.
- Infer task fields from how something is described rather than interrogating the user.
  "Quickly reply to Dana" is shallow, short and probably P3.
- You cannot delete anything. If asked, say so and offer to complete or archive instead.
- Refer to areas as work and personal, never as "domains".`;

export interface UseChatOptions extends ToolDeps {
  transport?: ChatTransport;
}

// The UI reads the database through useLiveQuery, so tool writes refresh the
// rest of the app on their own — nothing here needs to announce them.
export function useChat({ transport, ...deps }: UseChatOptions) {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const history = useRef<ApiMessage[]>([]);
  const nextId = useRef(1);
  const abort = useRef<AbortController | null>(null);

  const append = useCallback((entry: Omit<ChatEntry, 'id'>) => {
    setEntries((prev) => [...prev, { ...entry, id: nextId.current++ }]);
  }, []);

  const reset = useCallback(() => {
    history.current = [];
    setEntries([]);
  }, []);

  const stop = useCallback(() => {
    abort.current?.abort();
    abort.current = null;
    setBusy(false);
  }, []);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;

      append({ role: 'user', text: trimmed });
      history.current.push({ role: 'user', content: trimmed });
      setBusy(true);

      const controller = new AbortController();
      abort.current = controller;
      const client = transport ?? httpTransport;

      try {
        for (let step = 0; step < MAX_STEPS; step++) {
          const reply = await client.send({
            model,
            system: SYSTEM,
            messages: history.current,
            tools: TOOL_SCHEMAS,
            signal: controller.signal,
          });

          history.current.push({ role: 'assistant', content: reply.content });

          for (const block of reply.content) {
            if (block.type === 'text' && block.text.trim()) {
              append({ role: 'assistant', text: block.text.trim() });
            }
          }

          const calls = reply.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
          if (calls.length === 0) break;

          const results: ContentBlock[] = [];
          for (const call of calls) {
            try {
              const output = await executeTool(call.name, call.input, deps);
              append({ role: 'tool', toolName: call.name, text: describeCall(call) });
              results.push({
                type: 'tool_result',
                tool_use_id: call.id,
                content: JSON.stringify(output),
              });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              append({ role: 'tool', toolName: call.name, text: message, failed: true });
              // Handed back to the model rather than thrown: a bad id is
              // something it can recover from by looking the task up.
              results.push({
                type: 'tool_result',
                tool_use_id: call.id,
                content: message,
                is_error: true,
              });
            }
          }

          history.current.push({ role: 'user', content: results });
          if (step === MAX_STEPS - 1) {
            append({ role: 'error', text: 'Stopped after too many steps in a row.' });
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          append({ role: 'error', text: err instanceof Error ? err.message : String(err) });
        }
      } finally {
        abort.current = null;
        setBusy(false);
      }
    },
    [append, busy, deps, model, transport],
  );

  return { entries, busy, send, reset, stop, model, setModel };
}

/** Short human summary of what a tool call did, for the transcript. */
function describeCall(call: ToolUseBlock): string {
  const input = call.input;
  switch (call.name) {
    case 'create_task':
      return `Added "${String(input.title)}"`;
    case 'update_task':
      return `Updated task ${String(input.id)}`;
    case 'complete_task':
      return input.done === false
        ? `Reopened task ${String(input.id)}`
        : `Completed task ${String(input.id)}`;
    case 'create_project':
      return `Created project "${String(input.name)}"`;
    case 'set_context':
      return `Set ${Object.entries(input)
        .map(([k, v]) => `${k} to ${String(v)}`)
        .join(', ')}`;
    case 'recommend':
      return 'Asked the scoring engine';
    case 'list_projects':
      return 'Read your projects';
    default:
      return 'Read your tasks';
  }
}
