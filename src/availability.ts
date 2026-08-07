/**
 * Whether a task can actually be started right now.
 *
 * Priority, duration and focus all describe how *worthwhile* a task is. These
 * describe whether it is even possible, which is a different question and has
 * to be answered first: no ranking is useful if the top result is something you
 * are waiting on someone else for, or that you promised yourself not to open
 * until next Monday.
 *
 * Everything here is pure and takes the task table as a map, so the recommender,
 * the list filters and the row renderer all reach the same verdict.
 */
import type { Task, TaskContext } from './types';
import { todayISO } from './dates';

export type TaskMap = Map<number, Task>;

export function indexTasks(tasks: Task[]): TaskMap {
  return new Map(tasks.flatMap((t) => (t.id === undefined ? [] : [[t.id, t] as const])));
}

/**
 * The task standing in the way, when there is one and it is still open.
 *
 * A dangling id is treated as no blocker rather than as an error: the blocker
 * may have been deleted, and silently hiding a task forever because of a
 * reference to something that no longer exists is the worst possible outcome.
 */
export function blockerOf(task: Task, byId: TaskMap): Task | undefined {
  if (task.blockedBy === undefined) return undefined;
  const blocker = byId.get(task.blockedBy);
  if (!blocker || blocker.status === 'done') return undefined;
  return blocker;
}

/**
 * Blocked means "someone or something else has to move first". Writing down
 * what you are waiting on is itself the declaration — there is no separate flag
 * to forget to tick, and clearing the note is how you unblock.
 */
export function isBlocked(task: Task, byId: TaskMap): boolean {
  return !!task.blockedNote?.trim() || blockerOf(task, byId) !== undefined;
}

/** A short human reason, for the row badge and the recommender's explanation. */
export function blockedReason(task: Task, byId: TaskMap): string | undefined {
  const blocker = blockerOf(task, byId);
  if (blocker) return `Waiting on “${blocker.title}”`;
  const note = task.blockedNote?.trim();
  return note ? `Waiting on ${note}` : undefined;
}

/** True when a "not before" date has not arrived yet. */
export function isDeferred(task: Task, today: string = todayISO()): boolean {
  return !!task.startDate && task.startDate > today;
}

/** Open, unblocked, and past its earliest start date. */
export function isActionable(task: Task, byId: TaskMap, today: string = todayISO()): boolean {
  return task.status === 'todo' && !isBlocked(task, byId) && !isDeferred(task, today);
}

/**
 * True when a task's context rules it out of the situation you are in.
 *
 * Only an explicit mismatch counts. A task with no context needs nothing in
 * particular and stays available everywhere, which keeps the feature opt-in:
 * setting "I'm on my phone" narrows the list rather than emptying it.
 */
export function contextExcludes(task: Task, where: TaskContext | 'any' | undefined): boolean {
  if (!where || where === 'any') return false;
  return task.context !== undefined && task.context !== where;
}

/**
 * True when making `candidate` the blocker of `taskId` would create a cycle.
 *
 * Each task has at most one blocker, so the chain is a simple walk; the length
 * guard is belt-and-braces against a cycle that somehow already exists in the
 * data (an import, say) sending this into an infinite loop.
 */
export function wouldCycle(taskId: number, candidateId: number, byId: TaskMap): boolean {
  if (taskId === candidateId) return true;
  let current = byId.get(candidateId);
  for (let hops = 0; current && hops <= byId.size; hops++) {
    if (current.id === taskId) return true;
    if (current.blockedBy === undefined) return false;
    current = byId.get(current.blockedBy);
  }
  return true;
}

/** Tasks that may be chosen as a blocker for `task`, cycles and itself removed. */
export function blockerCandidates(task: Task | undefined, tasks: Task[]): Task[] {
  const byId = indexTasks(tasks);
  return tasks.filter(
    (t) =>
      t.id !== undefined &&
      t.status === 'todo' &&
      (task?.id === undefined || !wouldCycle(task.id, t.id, byId)),
  );
}
