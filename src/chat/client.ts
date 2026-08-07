import { getApiKey } from './key';

/**
 * Minimal Anthropic Messages API client, written against `fetch` rather than
 * the official SDK. The SDK targets Node first and would pull a substantial
 * dependency into a bundle that is currently ~110 KB gzipped, and the only
 * thing it does that matters here is set one header.
 *
 * That header is the whole trick: `api.anthropic.com` refuses cross-origin
 * browser requests unless `anthropic-dangerous-direct-browser-access` is set,
 * which is what lets a backend-less app talk to the API at all. It is opt-in
 * precisely because sending a key from a browser is dangerous when the key is
 * the *developer's*. Here it is the user's own key, in their own browser,
 * talking to their own account, which is the one case where the risk is theirs
 * to take knowingly.
 */
const API_URL = 'https://api.anthropic.com/v1';
const API_VERSION = '2023-06-01';

/** Model ids change over time, so this is only the initial selection. */
export const DEFAULT_MODEL = 'claude-sonnet-4-5';

export interface ToolSchema {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface ApiMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface MessageResponse {
  content: ContentBlock[];
  stop_reason: string | null;
}

export interface SendOptions {
  model: string;
  system: string;
  messages: ApiMessage[];
  tools: ToolSchema[];
  signal?: AbortSignal;
}

/**
 * Swapped for an in-memory fake in tests, the same way the sync engine takes a
 * client rather than reaching for `fetch` itself. Nothing else in the chat
 * stack knows whether it is talking to Anthropic or to a script.
 */
export interface ChatTransport {
  send(options: SendOptions): Promise<MessageResponse>;
}

function headers(): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-api-key': getApiKey(),
    'anthropic-version': API_VERSION,
    'anthropic-dangerous-direct-browser-access': 'true',
  };
}

/**
 * Anthropic returns a JSON body with a useful message on failure; surfacing it
 * turns "something went wrong" into "your credit balance is too low", which is
 * the difference between a fixable problem and a mystery.
 */
async function describeFailure(res: Response): Promise<string> {
  let detail = '';
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    detail = body.error?.message ?? '';
  } catch {
    detail = '';
  }
  if (res.status === 401) return detail || 'That API key was rejected. Check it and try again.';
  if (res.status === 429) return detail || 'Rate limited by Anthropic. Wait a moment and retry.';
  return detail || `Anthropic returned ${res.status}.`;
}

export const httpTransport: ChatTransport = {
  async send({ model, system, messages, tools, signal }) {
    const res = await fetch(`${API_URL}/messages`, {
      method: 'POST',
      headers: headers(),
      signal,
      body: JSON.stringify({ model, max_tokens: 2048, system, messages, tools }),
    });
    if (!res.ok) throw new Error(await describeFailure(res));
    const body = (await res.json()) as MessageResponse;
    return { content: body.content ?? [], stop_reason: body.stop_reason ?? null };
  },
};

/**
 * Model ids are versioned and retired, so the picker is populated from the API
 * rather than from a list baked in here that would rot.
 */
export async function listModels(): Promise<string[]> {
  const res = await fetch(`${API_URL}/models?limit=100`, { headers: headers() });
  if (!res.ok) throw new Error(await describeFailure(res));
  const body = (await res.json()) as { data?: { id: string }[] };
  return (body.data ?? []).map((m) => m.id);
}
