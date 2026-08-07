/**
 * Minimal typings for the slice of Microsoft Graph To Do we use.
 * Hand-written rather than pulled from a SDK to keep the bundle small and the
 * contract obvious at the call sites.
 */

export type GraphImportance = 'low' | 'normal' | 'high';

export type GraphTaskStatus =
  | 'notStarted'
  | 'inProgress'
  | 'completed'
  | 'waitingOnOthers'
  | 'deferred';

export interface GraphDateTimeZone {
  dateTime: string;
  timeZone: string;
}

export interface GraphItemBody {
  content: string;
  contentType: 'text' | 'html';
}

export interface GraphTodoTaskList {
  id: string;
  displayName: string;
  isOwner?: boolean;
  isShared?: boolean;
  wellknownListName?: 'none' | 'defaultList' | 'flaggedEmails' | 'unknownFutureValue';
  '@removed'?: { reason: string };
}

export interface GraphTodoTask {
  id: string;
  title: string;
  body?: GraphItemBody;
  importance?: GraphImportance;
  status?: GraphTaskStatus;
  categories?: string[];
  dueDateTime?: GraphDateTimeZone | null;
  completedDateTime?: GraphDateTimeZone | null;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  '@removed'?: { reason: string };
}

/** Shape of a Graph collection response, including delta/paging links. */
export interface GraphCollection<T> {
  value: T[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

/** Fields we are willing to write. Graph rejects unknown/readonly properties. */
export type GraphTaskWrite = Pick<GraphTodoTask, 'title'> &
  Partial<Pick<GraphTodoTask, 'body' | 'importance' | 'status' | 'categories' | 'dueDateTime'>>;

export interface DeltaPage {
  tasks: GraphTodoTask[];
  deltaLink?: string;
}

/**
 * Transport contract for the sync engine. Keeping this an interface lets the
 * engine be exercised against an in-memory fake with no network or credentials.
 */
export interface GraphClient {
  listLists(): Promise<GraphTodoTaskList[]>;
  createList(displayName: string): Promise<GraphTodoTaskList>;
  updateList(listId: string, displayName: string): Promise<GraphTodoTaskList>;
  deleteList(listId: string): Promise<void>;

  /** Incremental listing. `deltaLink` undefined means "start a new delta cycle". */
  deltaTasks(listId: string, deltaLink?: string): Promise<DeltaPage>;

  createTask(listId: string, task: GraphTaskWrite): Promise<GraphTodoTask>;
  updateTask(listId: string, taskId: string, task: Partial<GraphTaskWrite>): Promise<GraphTodoTask>;
  deleteTask(listId: string, taskId: string): Promise<void>;
}
