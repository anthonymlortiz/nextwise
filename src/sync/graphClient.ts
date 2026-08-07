import type {
  DeltaPage,
  GraphClient,
  GraphCollection,
  GraphTaskWrite,
  GraphTodoTask,
  GraphTodoTaskList,
} from './graphTypes';

const GRAPH_ROOT = 'https://graph.microsoft.com/v1.0';

export type TokenProvider = () => Promise<string>;

export class GraphError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'GraphError';
    this.status = status;
    this.code = code;
  }
}

interface GraphErrorBody {
  error?: { code?: string; message?: string };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Thin fetch wrapper over the Microsoft Graph To Do endpoints.
 *
 * Graph throttles aggressively per-mailbox, so 429 and 503 are retried with the
 * server-provided Retry-After; without this a first full sync of a large list
 * fails partway through and leaves records half-pushed.
 */
export class MsGraphClient implements GraphClient {
  private readonly getToken: TokenProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;

  constructor(
    getToken: TokenProvider,
    fetchImpl: typeof fetch = fetch.bind(globalThis),
    maxRetries = 3,
  ) {
    this.getToken = getToken;
    this.fetchImpl = fetchImpl;
    this.maxRetries = maxRetries;
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    attempt = 0,
  ): Promise<T | undefined> {
    const token = await this.getToken();
    const url = path.startsWith('http') ? path : `${GRAPH_ROOT}${path}`;

    const res = await this.fetchImpl(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });

    if (res.status === 429 || res.status === 503) {
      if (attempt >= this.maxRetries) {
        throw new GraphError('Microsoft Graph is throttling requests', res.status, 'tooManyRequests');
      }
      const retryAfter = Number(res.headers.get('Retry-After'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 1000);
      return this.request<T>(path, init, attempt + 1);
    }

    if (res.status === 204) return undefined;

    if (!res.ok) {
      let code: string | undefined;
      let message = `${res.status} ${res.statusText}`;
      try {
        const body = (await res.json()) as GraphErrorBody;
        code = body.error?.code;
        if (body.error?.message) message = body.error.message;
      } catch {
        // Non-JSON error bodies are fine to ignore; status still tells the story.
      }
      throw new GraphError(message, res.status, code);
    }

    return (await res.json()) as T;
  }

  /** Walks `@odata.nextLink` until the collection is exhausted. */
  private async collectAll<T>(firstPath: string): Promise<T[]> {
    const out: T[] = [];
    let next: string | undefined = firstPath;
    while (next) {
      const page: GraphCollection<T> | undefined = await this.request<GraphCollection<T>>(next);
      if (!page) break;
      out.push(...page.value);
      next = page['@odata.nextLink'];
    }
    return out;
  }

  listLists(): Promise<GraphTodoTaskList[]> {
    return this.collectAll<GraphTodoTaskList>('/me/todo/lists');
  }

  async createList(displayName: string): Promise<GraphTodoTaskList> {
    const created = await this.request<GraphTodoTaskList>('/me/todo/lists', {
      method: 'POST',
      body: JSON.stringify({ displayName }),
    });
    return created!;
  }

  async updateList(listId: string, displayName: string): Promise<GraphTodoTaskList> {
    const updated = await this.request<GraphTodoTaskList>(`/me/todo/lists/${listId}`, {
      method: 'PATCH',
      body: JSON.stringify({ displayName }),
    });
    return updated!;
  }

  async deleteList(listId: string): Promise<void> {
    await this.request<void>(`/me/todo/lists/${listId}`, { method: 'DELETE' });
  }

  /**
   * Follows nextLinks to the end of the delta cycle and returns the final
   * deltaLink, which the caller persists to resume from next time.
   */
  async deltaTasks(listId: string, deltaLink?: string): Promise<DeltaPage> {
    const tasks: GraphTodoTask[] = [];
    let next: string | undefined = deltaLink ?? `/me/todo/lists/${listId}/tasks/delta`;
    let finalDelta: string | undefined;

    while (next) {
      const page: GraphCollection<GraphTodoTask> | undefined =
        await this.request<GraphCollection<GraphTodoTask>>(next);
      if (!page) break;
      tasks.push(...page.value);
      finalDelta = page['@odata.deltaLink'] ?? finalDelta;
      next = page['@odata.nextLink'];
    }

    return { tasks, deltaLink: finalDelta };
  }

  async createTask(listId: string, task: GraphTaskWrite): Promise<GraphTodoTask> {
    const created = await this.request<GraphTodoTask>(`/me/todo/lists/${listId}/tasks`, {
      method: 'POST',
      body: JSON.stringify(task),
    });
    return created!;
  }

  async updateTask(
    listId: string,
    taskId: string,
    task: Partial<GraphTaskWrite>,
  ): Promise<GraphTodoTask> {
    const updated = await this.request<GraphTodoTask>(
      `/me/todo/lists/${listId}/tasks/${taskId}`,
      { method: 'PATCH', body: JSON.stringify(task) },
    );
    return updated!;
  }

  async deleteTask(listId: string, taskId: string): Promise<void> {
    await this.request<void>(`/me/todo/lists/${listId}/tasks/${taskId}`, { method: 'DELETE' });
  }
}
