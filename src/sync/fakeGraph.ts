import type {
  DeltaPage,
  GraphClient,
  GraphTaskWrite,
  GraphTodoTask,
  GraphTodoTaskList,
} from './graphTypes';

interface StoredTask extends GraphTodoTask {
  _version: number;
  _listId: string;
}

interface StoredList extends GraphTodoTaskList {
  _version: number;
}

class NotFound extends Error {
  readonly status = 404;
  constructor(what: string) {
    super(`${what} not found`);
  }
}

/**
 * In-memory stand-in for Microsoft Graph To Do.
 *
 * It reproduces the behaviours the engine actually depends on — server-assigned
 * ids, `lastModifiedDateTime` bumps, and delta cycles that report `@removed`
 * tombstones — so the sync algorithm can be tested end-to-end without an Azure
 * tenant or network access.
 */
export class FakeGraphClient implements GraphClient {
  private lists = new Map<string, StoredList>();
  private tasks = new Map<string, StoredTask>();
  private removed: { id: string; listId: string; version: number }[] = [];
  private version = 0;
  private seq = 0;
  private clock: number;

  /** Every call is counted so tests can assert a repeat sync writes nothing. */
  readonly calls = {
    listLists: 0,
    createList: 0,
    updateList: 0,
    deleteList: 0,
    deltaTasks: 0,
    createTask: 0,
    updateTask: 0,
    deleteTask: 0,
  };

  constructor(opts: { withDefaultList?: boolean; startTime?: number } = {}) {
    // Defaults to wall time so `lastModifiedDateTime` is comparable to local
    // `updatedAt` clocks, exactly as a real Graph server would be.
    this.clock = opts.startTime ?? Date.now();
    if (opts.withDefaultList !== false) {
      const id = this.nextId('list');
      this.lists.set(id, {
        id,
        displayName: 'Tasks',
        wellknownListName: 'defaultList',
        _version: ++this.version,
      });
    }
  }

  private nextId(prefix: string): string {
    return `${prefix}-${++this.seq}`;
  }

  private stamp(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  /** Lets tests simulate an edit made in the To Do app at a chosen time. */
  advanceClock(ms: number): void {
    this.clock += ms;
  }

  get now(): number {
    return this.clock;
  }

  async listLists(): Promise<GraphTodoTaskList[]> {
    this.calls.listLists++;
    return [...this.lists.values()].map(({ _version, ...rest }) => ({ ...rest }));
  }

  async createList(displayName: string): Promise<GraphTodoTaskList> {
    this.calls.createList++;
    const id = this.nextId('list');
    const list: StoredList = { id, displayName, wellknownListName: 'none', _version: ++this.version };
    this.lists.set(id, list);
    return { id, displayName, wellknownListName: 'none' };
  }

  async updateList(listId: string, displayName: string): Promise<GraphTodoTaskList> {
    this.calls.updateList++;
    const list = this.lists.get(listId);
    if (!list) throw new NotFound(`list ${listId}`);
    list.displayName = displayName;
    list._version = ++this.version;
    return { id: list.id, displayName, wellknownListName: list.wellknownListName };
  }

  async deleteList(listId: string): Promise<void> {
    this.calls.deleteList++;
    if (!this.lists.delete(listId)) throw new NotFound(`list ${listId}`);
    for (const [id, task] of this.tasks) {
      if (task._listId === listId) {
        this.tasks.delete(id);
        this.removed.push({ id, listId, version: ++this.version });
      }
    }
  }

  async deltaTasks(listId: string, deltaLink?: string): Promise<DeltaPage> {
    this.calls.deltaTasks++;
    if (!this.lists.has(listId)) throw new NotFound(`list ${listId}`);

    const since = deltaLink ? Number(deltaLink.split(':').pop()) : 0;
    const changed = [...this.tasks.values()]
      .filter((t) => t._listId === listId && t._version > since)
      .map(({ _version, _listId, ...rest }) => ({ ...rest }) as GraphTodoTask);

    const gone = this.removed
      .filter((r) => r.listId === listId && r.version > since)
      .map((r) => ({ id: r.id, title: '', '@removed': { reason: 'deleted' } }) as GraphTodoTask);

    return {
      tasks: [...changed, ...gone],
      deltaLink: `delta:${listId}:${this.version}`,
    };
  }

  async createTask(listId: string, input: GraphTaskWrite): Promise<GraphTodoTask> {
    this.calls.createTask++;
    if (!this.lists.has(listId)) throw new NotFound(`list ${listId}`);
    const id = this.nextId('task');
    const created = this.stamp();
    const task: StoredTask = {
      id,
      title: input.title,
      body: input.body ?? { content: '', contentType: 'text' },
      importance: input.importance ?? 'normal',
      status: input.status ?? 'notStarted',
      categories: input.categories ?? [],
      dueDateTime: input.dueDateTime ?? null,
      completedDateTime: input.status === 'completed' ? { dateTime: created, timeZone: 'UTC' } : null,
      createdDateTime: created,
      lastModifiedDateTime: created,
      _version: ++this.version,
      _listId: listId,
    };
    this.tasks.set(id, task);
    const { _version, _listId, ...rest } = task;
    return { ...rest };
  }

  async updateTask(
    listId: string,
    taskId: string,
    patch: Partial<GraphTaskWrite>,
  ): Promise<GraphTodoTask> {
    this.calls.updateTask++;
    const task = this.tasks.get(taskId);
    if (!task || task._listId !== listId) throw new NotFound(`task ${taskId}`);
    Object.assign(task, patch);
    task.lastModifiedDateTime = this.stamp();
    task._version = ++this.version;
    if (patch.status === 'completed' && !task.completedDateTime) {
      task.completedDateTime = { dateTime: task.lastModifiedDateTime, timeZone: 'UTC' };
    }
    if (patch.status && patch.status !== 'completed') task.completedDateTime = null;
    const { _version, _listId, ...rest } = task;
    return { ...rest };
  }

  async deleteTask(listId: string, taskId: string): Promise<void> {
    this.calls.deleteTask++;
    const task = this.tasks.get(taskId);
    if (!task || task._listId !== listId) throw new NotFound(`task ${taskId}`);
    this.tasks.delete(taskId);
    this.removed.push({ id: taskId, listId, version: ++this.version });
  }

  // ---- helpers used by tests to act as "the To Do app" ----

  /** `id` is settable so tests can stand up a server matching existing links. */
  seedList(displayName: string, id: string = this.nextId('list')): string {
    this.lists.set(id, { id, displayName, wellknownListName: 'none', _version: ++this.version });
    return id;
  }

  seedTask(
    listId: string,
    task: Partial<GraphTodoTask> & { title: string },
    id: string = this.nextId('task'),
  ): string {
    const created = this.stamp();
    this.tasks.set(id, {
      id,
      title: task.title,
      body: task.body ?? { content: '', contentType: 'text' },
      importance: task.importance ?? 'normal',
      status: task.status ?? 'notStarted',
      categories: task.categories ?? [],
      dueDateTime: task.dueDateTime ?? null,
      completedDateTime: null,
      createdDateTime: created,
      lastModifiedDateTime: created,
      _version: ++this.version,
      _listId: listId,
    });
    return id;
  }

  /** Simulates a user editing the task inside Microsoft To Do. */
  editTaskRemotely(taskId: string, patch: Partial<GraphTodoTask>): void {
    const task = this.tasks.get(taskId);
    if (!task) throw new NotFound(`task ${taskId}`);
    Object.assign(task, patch);
    task.lastModifiedDateTime = this.stamp();
    task._version = ++this.version;
  }

  getTask(taskId: string): GraphTodoTask | undefined {
    const t = this.tasks.get(taskId);
    if (!t) return undefined;
    const { _version, _listId, ...rest } = t;
    return { ...rest };
  }

  findTaskByTitle(title: string): GraphTodoTask | undefined {
    return [...this.tasks.values()].find((t) => t.title === title);
  }

  tasksInList(listId: string): GraphTodoTask[] {
    return [...this.tasks.values()]
      .filter((t) => t._listId === listId)
      .map(({ _version, _listId, ...rest }) => ({ ...rest }));
  }

  listNames(): string[] {
    return [...this.lists.values()].map((l) => l.displayName).sort();
  }

  findListByName(name: string): GraphTodoTaskList | undefined {
    return [...this.lists.values()].find((l) => l.displayName === name);
  }

  get taskCount(): number {
    return this.tasks.size;
  }

  resetCallCounts(): void {
    for (const key of Object.keys(this.calls) as (keyof typeof this.calls)[]) {
      this.calls[key] = 0;
    }
  }
}
