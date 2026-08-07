/**
 * Minimal typings for the slice of the Google Tasks v1 API we use.
 * Hand-written for the same reasons as the Graph types: a small bundle and an
 * obvious contract at the call sites.
 */

export type GoogleTaskStatus = 'needsAction' | 'completed';

export interface GoogleTaskList {
  id: string;
  title: string;
  updated?: string;
  etag?: string;
}

export interface GoogleTask {
  id: string;
  title?: string;
  notes?: string;
  status?: GoogleTaskStatus;
  /** RFC3339. Google stores the date only and ignores the time component. */
  due?: string;
  completed?: string;
  deleted?: boolean;
  hidden?: boolean;
  updated?: string;
  etag?: string;
  position?: string;
  parent?: string;
}

/** Fields we are willing to write. Everything else is server-managed. */
export interface GoogleTaskWrite {
  title: string;
  notes: string;
  status: GoogleTaskStatus;
  due?: string;
  completed?: string;
}

export interface GoogleCollection<T> {
  items?: T[];
  nextPageToken?: string;
}

export interface GoogleTaskPage {
  tasks: GoogleTask[];
  /** RFC3339 watermark to pass as `updatedMin` on the next run. */
  cursor: string;
}

/**
 * Transport contract for the Google side, mirroring `GraphClient`. Keeping it
 * an interface lets the engine be exercised against an in-memory fake with no
 * Google Cloud project or credentials.
 */
export interface GoogleClient {
  listLists(): Promise<GoogleTaskList[]>;
  defaultListId(): Promise<string | undefined>;
  createList(title: string): Promise<GoogleTaskList>;
  updateList(listId: string, title: string): Promise<GoogleTaskList>;
  deleteList(listId: string): Promise<void>;

  /** Tasks changed at or after `updatedMin`, or everything when it is omitted. */
  listTasks(listId: string, updatedMin?: string): Promise<GoogleTaskPage>;

  createTask(listId: string, task: GoogleTaskWrite): Promise<GoogleTask>;
  updateTask(listId: string, taskId: string, task: GoogleTaskWrite): Promise<GoogleTask>;
  deleteTask(listId: string, taskId: string): Promise<void>;
}
