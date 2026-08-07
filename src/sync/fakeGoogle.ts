import type {
  GoogleClient,
  GoogleTask,
  GoogleTaskList,
  GoogleTaskPage,
  GoogleTaskWrite,
} from './googleTypes';

interface StoredTask extends GoogleTask {
  _listId: string;
}

class NotFound extends Error {
  readonly status = 404;
  constructor(what: string) {
    super(`${what} not found`);
  }
}

/**
 * In-memory stand-in for the Google Tasks API.
 *
 * It reproduces the behaviours the engine depends on — server-assigned ids,
 * `updated` bumps, `updatedMin` filtering and deleted-task tombstones — so the
 * sync algorithm can be tested end to end without a Google Cloud project or
 * network access.
 *
 * The clock is virtual but anchored to wall time, so `updated` stamps stay
 * comparable to local `updatedAt` values exactly as the real service would be.
 */
export class FakeGoogleClient implements GoogleClient {
  private lists = new Map<string, GoogleTaskList>();
  private tasks = new Map<string, StoredTask>();
  private defaultId: string | undefined;
  private seq = 0;
  private clock: number;

  /** Every call is counted so tests can assert a repeat sync writes nothing. */
  readonly calls = {
    listLists: 0,
    defaultListId: 0,
    createList: 0,
    updateList: 0,
    deleteList: 0,
    listTasks: 0,
    createTask: 0,
    updateTask: 0,
    deleteTask: 0,
  };

  constructor(opts: { withDefaultList?: boolean; startTime?: number } = {}) {
    this.clock = opts.startTime ?? Date.now();
    if (opts.withDefaultList !== false) {
      const id = this.nextId('glist');
      this.lists.set(id, { id, title: 'My Tasks', updated: this.stamp() });
      this.defaultId = id;
    }
  }

  private nextId(prefix: string): string {
    return `${prefix}-${++this.seq}`;
  }

  private stamp(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  /** Lets tests simulate an edit made in the Google Tasks app at a chosen time. */
  advanceClock(ms: number): void {
    this.clock += ms;
  }

  get now(): number {
    return this.clock;
  }

  async listLists(): Promise<GoogleTaskList[]> {
    this.calls.listLists++;
    return [...this.lists.values()].map((l) => ({ ...l }));
  }

  async defaultListId(): Promise<string | undefined> {
    this.calls.defaultListId++;
    return this.defaultId;
  }

  async createList(title: string): Promise<GoogleTaskList> {
    this.calls.createList++;
    const id = this.nextId('glist');
    const list: GoogleTaskList = { id, title, updated: this.stamp() };
    this.lists.set(id, list);
    return { ...list };
  }

  async updateList(listId: string, title: string): Promise<GoogleTaskList> {
    this.calls.updateList++;
    const list = this.lists.get(listId);
    if (!list) throw new NotFound(`list ${listId}`);
    list.title = title;
    list.updated = this.stamp();
    return { ...list };
  }

  async deleteList(listId: string): Promise<void> {
    this.calls.deleteList++;
    if (!this.lists.delete(listId)) throw new NotFound(`list ${listId}`);
    if (this.defaultId === listId) this.defaultId = undefined;
    for (const task of this.tasks.values()) {
      if (task._listId === listId) {
        task.deleted = true;
        task.updated = this.stamp();
      }
    }
  }

  async listTasks(listId: string, updatedMin?: string): Promise<GoogleTaskPage> {
    this.calls.listTasks++;
    if (!this.lists.has(listId)) throw new NotFound(`list ${listId}`);

    const floor = updatedMin ? Date.parse(updatedMin) : 0;
    const tasks = [...this.tasks.values()]
      .filter((t) => t._listId === listId && Date.parse(t.updated ?? '') >= floor)
      .map(({ _listId, ...rest }) => ({ ...rest }));

    return { tasks, cursor: new Date(this.clock).toISOString() };
  }

  async createTask(listId: string, input: GoogleTaskWrite): Promise<GoogleTask> {
    this.calls.createTask++;
    if (!this.lists.has(listId)) throw new NotFound(`list ${listId}`);
    const id = this.nextId('gtask');
    const task: StoredTask = {
      id,
      title: input.title,
      notes: input.notes,
      status: input.status,
      due: input.due,
      completed: input.status === 'completed' ? input.completed : undefined,
      updated: this.stamp(),
      _listId: listId,
    };
    this.tasks.set(id, task);
    const { _listId, ...rest } = task;
    return { ...rest };
  }

  /** Mirrors the real PUT semantics: fields absent from the body are cleared. */
  async updateTask(listId: string, taskId: string, input: GoogleTaskWrite): Promise<GoogleTask> {
    this.calls.updateTask++;
    const task = this.tasks.get(taskId);
    if (!task || task._listId !== listId) throw new NotFound(`task ${taskId}`);

    task.title = input.title;
    task.notes = input.notes;
    task.status = input.status;
    task.due = input.due;
    task.completed = input.status === 'completed' ? input.completed : undefined;
    task.updated = this.stamp();

    const { _listId, ...rest } = task;
    return { ...rest };
  }

  async deleteTask(listId: string, taskId: string): Promise<void> {
    this.calls.deleteTask++;
    const task = this.tasks.get(taskId);
    if (!task || task._listId !== listId || task.deleted) throw new NotFound(`task ${taskId}`);
    task.deleted = true;
    task.updated = this.stamp();
  }

  // ---- helpers used by tests to act as "the Google Tasks app" ----

  /** `id` is settable so tests can stand up a server matching existing links. */
  seedList(title: string, id: string = this.nextId('glist')): string {
    this.lists.set(id, { id, title, updated: this.stamp() });
    return id;
  }

  seedTask(
    listId: string,
    task: Partial<GoogleTask> & { title: string },
    id: string = this.nextId('gtask'),
  ): string {
    this.tasks.set(id, {
      id,
      title: task.title,
      notes: task.notes ?? '',
      status: task.status ?? 'needsAction',
      due: task.due,
      completed: task.completed,
      updated: this.stamp(),
      _listId: listId,
    });
    return id;
  }

  /** Simulates a user editing the task inside Google Tasks. */
  editTaskRemotely(taskId: string, patch: Partial<GoogleTask>): void {
    const task = this.tasks.get(taskId);
    if (!task) throw new NotFound(`task ${taskId}`);
    Object.assign(task, patch);
    task.updated = this.stamp();
  }

  getTask(taskId: string): GoogleTask | undefined {
    const t = this.tasks.get(taskId);
    if (!t) return undefined;
    const { _listId, ...rest } = t;
    return { ...rest };
  }

  findTaskByTitle(title: string): GoogleTask | undefined {
    return [...this.tasks.values()].find((t) => t.title === title && !t.deleted);
  }

  tasksInList(listId: string): GoogleTask[] {
    return [...this.tasks.values()]
      .filter((t) => t._listId === listId && !t.deleted)
      .map(({ _listId, ...rest }) => ({ ...rest }));
  }

  listNames(): string[] {
    return [...this.lists.values()].map((l) => l.title).sort();
  }

  findListByName(name: string): GoogleTaskList | undefined {
    return [...this.lists.values()].find((l) => l.title === name);
  }

  /** Live (non-deleted) tasks, matching what the user would see in the app. */
  get taskCount(): number {
    return [...this.tasks.values()].filter((t) => !t.deleted).length;
  }

  resetCallCounts(): void {
    for (const key of Object.keys(this.calls) as (keyof typeof this.calls)[]) {
      this.calls[key] = 0;
    }
  }
}
