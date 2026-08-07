import type { Domain, FocusLevel, Priority, ProviderId, Task, TaskContext } from '../types';

/**
 * The provider-neutral seam the sync engine talks to.
 *
 * Everything provider-specific — REST shapes, field mapping, how metadata that
 * has no native home is encoded — lives behind an adapter implementing this
 * interface. The engine only deals in the vocabulary below, so adding a service
 * never means touching the sync algorithm.
 */

/** A remote container of tasks: a To Do list, or a Google task list. */
export interface RemoteList {
  id: string;
  name: string;
  /** The account's built-in list, reused as the home for project-less tasks. */
  isDefault?: boolean;
  /** Lists the engine must not touch or import (e.g. To Do's flagged email). */
  ignore?: boolean;
}

/** A remote task already projected onto our model. */
export interface RemoteTaskFields {
  title: string;
  notes: string;
  priority: Priority;
  estimateMin: number;
  focusLevel: FocusLevel;
  domain: Domain;
  dueDate?: string;
  startDate?: string;
  context?: TaskContext;
  blockedNote?: string;
  status: 'todo' | 'done';
  tags: string[];
  completedAt?: number;
}

export interface RemoteTask {
  id: string;
  /** Absent for deletions. */
  fields?: RemoteTaskFields;
  /** Provider change marker; any difference means the remote copy moved on. */
  stamp?: string;
  createdAt?: number;
  removed?: boolean;
}

export interface RemoteTaskPage {
  tasks: RemoteTask[];
  /**
   * Opaque resume token handed back on the next run. Microsoft returns a delta
   * link; Google gets a timestamp for its `updatedMin` filter.
   */
  cursor?: string;
}

/**
 * The area records from each service fall into when nothing better is known.
 *
 * Each account tends to hold one side of a life — a Microsoft account is
 * usually the work one, a Google account the personal one — so the guess is
 * per-service rather than one global default. It is only ever a fallback: an
 * `[fb]` footer written by this app wins, and so does the domain of the
 * project a task lands in.
 *
 * Declared here, next to the seam, so the providers and the Sync tab that
 * advertises the behaviour cannot drift apart.
 */
export const DEFAULT_DOMAIN: Record<ProviderId, Domain> = {
  mstodo: 'work',
  gtasks: 'personal',
};

/**
 * Which halves of the board each service is allowed to hold.
 *
 * Work lives in Microsoft only; personal is mirrored to both. Google is a
 * personal account, so work items simply don't belong there.
 *
 * This is a push filter, not a pull filter — anything already in a service is
 * still read back. A record that stops qualifying is *withdrawn*: deleted from
 * that service and unlinked, never deleted locally. Withdrawal has to happen,
 * because merely unlinking would leave the record on the server for the next
 * pull to re-adopt, and it would ping-pong forever.
 */
export const PUSH_DOMAINS: Record<ProviderId, readonly Domain[]> = {
  mstodo: ['work', 'personal'],
  gtasks: ['personal'],
};

export interface SyncProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly defaultDomain: Domain;
  readonly pushDomains: readonly Domain[];

  listLists(): Promise<RemoteList[]>;
  createList(name: string): Promise<RemoteList>;
  renameList(id: string, name: string): Promise<void>;
  deleteList(id: string): Promise<void>;

  /**
   * Tasks changed since `cursor`, or everything when it is undefined.
   * `fallbackDomain` seeds the area for tasks authored outside this app.
   */
  changedTasks(
    listId: string,
    cursor: string | undefined,
    fallbackDomain: Domain,
  ): Promise<RemoteTaskPage>;

  createTask(listId: string, task: Task): Promise<RemoteTask>;
  updateTask(listId: string, remoteId: string, task: Task): Promise<RemoteTask>;
  deleteTask(listId: string, remoteId: string): Promise<void>;

  /** True when the remote copy already matches local, so a write can be skipped. */
  matches(local: Task, remote: RemoteTask): boolean;
}

/** Deletions that the server reports as "already gone" are a success for us. */
export function isMissing(err: unknown): boolean {
  const status = (err as { status?: number }).status;
  return status === 404 || status === 410;
}

/**
 * True when a remote task already carries everything local has, so the engine
 * can skip the write. Compared field by field on our own model rather than on
 * the raw payload, because both services rewrite bodies and echo server-side
 * timestamps, which would make any structural equality check always disagree.
 */
export function fieldsMatch(local: Task, remote: RemoteTask): boolean {
  const f = remote.fields;
  if (!f) return false;

  const localTags = local.tags ?? [];
  const sameTags =
    localTags.length === f.tags.length && localTags.every((t) => f.tags.includes(t));

  // An empty note and no note are the same thing, and only one of the two
  // survives the footer, so they have to compare equal or every task with a
  // blank field would be rewritten on every single run.
  const blank = (v: string | undefined) => (v?.trim() ? v.trim() : undefined);

  return (
    local.title === f.title &&
    (local.notes ?? '') === f.notes &&
    local.priority === f.priority &&
    local.estimateMin === f.estimateMin &&
    local.focusLevel === f.focusLevel &&
    local.domain === f.domain &&
    (local.dueDate ?? undefined) === f.dueDate &&
    (local.startDate ?? undefined) === f.startDate &&
    (local.context ?? undefined) === f.context &&
    blank(local.blockedNote) === blank(f.blockedNote) &&
    local.status === f.status &&
    sameTags
  );
}
