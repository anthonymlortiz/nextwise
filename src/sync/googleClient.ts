import type {
  GoogleClient,
  GoogleCollection,
  GoogleTask,
  GoogleTaskList,
  GoogleTaskPage,
  GoogleTaskWrite,
} from './googleTypes';

const TASKS_ROOT = 'https://tasks.googleapis.com/tasks/v1';

export type TokenProvider = () => Promise<string>;

export class GoogleApiError extends Error {
  readonly status: number;
  readonly reason?: string;

  constructor(message: string, status: number, reason?: string) {
    super(message);
    this.name = 'GoogleApiError';
    this.status = status;
    this.reason = reason;
  }
}

interface GoogleErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    errors?: { reason?: string }[];
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Google signals quota exhaustion with 403 plus a reason, not only with 429. */
const RATE_LIMIT_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'quotaExceeded',
  'backendError',
]);

/**
 * Thin fetch wrapper over the Google Tasks v1 endpoints.
 *
 * Like the Graph client it retries throttling responses, because a first full
 * sync of a large account otherwise fails partway through and leaves records
 * half-pushed.
 */
export class GoogleTasksClient implements GoogleClient {
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
    const res = await this.fetchImpl(`${TASKS_ROOT}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });

    if (res.status === 204 || res.status === 205) return undefined;

    if (!res.ok) {
      let reason: string | undefined;
      let message = `${res.status} ${res.statusText}`;
      try {
        const body = (await res.json()) as GoogleErrorBody;
        reason = body.error?.errors?.[0]?.reason;
        if (body.error?.message) message = body.error.message;
      } catch {
        // Non-JSON error bodies are fine to ignore; status still tells the story.
      }

      const retryable =
        res.status === 429 ||
        res.status >= 500 ||
        (res.status === 403 && reason !== undefined && RATE_LIMIT_REASONS.has(reason));

      if (retryable && attempt < this.maxRetries) {
        const retryAfter = Number(res.headers.get('Retry-After'));
        await sleep(
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 1000,
        );
        return this.request<T>(path, init, attempt + 1);
      }

      throw new GoogleApiError(message, res.status, reason);
    }

    const text = await res.text();
    return text ? (JSON.parse(text) as T) : undefined;
  }

  /** Walks `nextPageToken` until the collection is exhausted. */
  private async collectAll<T>(path: string, params: URLSearchParams): Promise<T[]> {
    const out: T[] = [];
    let pageToken: string | undefined;

    do {
      const query = new URLSearchParams(params);
      if (pageToken) query.set('pageToken', pageToken);
      const page = await this.request<GoogleCollection<T>>(`${path}?${query}`);
      if (!page) break;
      out.push(...(page.items ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);

    return out;
  }

  listLists(): Promise<GoogleTaskList[]> {
    return this.collectAll<GoogleTaskList>(
      '/users/@me/lists',
      new URLSearchParams({ maxResults: '100' }),
    );
  }

  /**
   * Google has no flag marking the default list, but `@default` resolves to it,
   * which is enough to recognise it in the full listing.
   */
  async defaultListId(): Promise<string | undefined> {
    try {
      const list = await this.request<GoogleTaskList>('/users/@me/lists/@default');
      return list?.id;
    } catch {
      // A brand-new account may not have one yet; the engine then creates ours.
      return undefined;
    }
  }

  async createList(title: string): Promise<GoogleTaskList> {
    const created = await this.request<GoogleTaskList>('/users/@me/lists', {
      method: 'POST',
      body: JSON.stringify({ title }),
    });
    return created!;
  }

  async updateList(listId: string, title: string): Promise<GoogleTaskList> {
    const updated = await this.request<GoogleTaskList>(
      `/users/@me/lists/${encodeURIComponent(listId)}`,
      { method: 'PATCH', body: JSON.stringify({ id: listId, title }) },
    );
    return updated!;
  }

  async deleteList(listId: string): Promise<void> {
    await this.request<void>(`/users/@me/lists/${encodeURIComponent(listId)}`, {
      method: 'DELETE',
    });
  }

  /**
   * Google has no delta endpoint, so incremental sync is an `updatedMin` filter.
   * `showDeleted`/`showHidden` are essential: without them a task deleted or a
   * completed task cleared on the phone would simply never come back, and the
   * push phase would recreate it forever.
   */
  async listTasks(listId: string, updatedMin?: string): Promise<GoogleTaskPage> {
    const cursor = new Date().toISOString();
    const params = new URLSearchParams({
      maxResults: '100',
      showCompleted: 'true',
      showHidden: 'true',
      showDeleted: 'true',
    });
    if (updatedMin) params.set('updatedMin', updatedMin);

    const tasks = await this.collectAll<GoogleTask>(
      `/lists/${encodeURIComponent(listId)}/tasks`,
      params,
    );
    return { tasks, cursor };
  }

  async createTask(listId: string, task: GoogleTaskWrite): Promise<GoogleTask> {
    const created = await this.request<GoogleTask>(
      `/lists/${encodeURIComponent(listId)}/tasks`,
      { method: 'POST', body: JSON.stringify(task) },
    );
    return created!;
  }

  /**
   * PUT rather than PATCH: clearing a due date by sending `due: null` is a
   * long-standing no-op in this API, whereas a full update drops any field the
   * body omits, which is exactly the semantics we want.
   */
  async updateTask(listId: string, taskId: string, task: GoogleTaskWrite): Promise<GoogleTask> {
    const updated = await this.request<GoogleTask>(
      `/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`,
      { method: 'PUT', body: JSON.stringify({ ...task, id: taskId }) },
    );
    return updated!;
  }

  async deleteTask(listId: string, taskId: string): Promise<void> {
    await this.request<void>(
      `/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`,
      { method: 'DELETE' },
    );
  }
}
