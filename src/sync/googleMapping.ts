import type { Domain, Task } from '../types';
import { joinBody, splitBody } from './footer';
import type { GoogleTask, GoogleTaskWrite } from './googleTypes';
import type { RemoteTaskFields } from './provider';

/**
 * Google Tasks is a much thinner model than To Do: there is no priority, no
 * categories, no importance — only title, notes, due date and done/not done.
 *
 * So everything the recommender needs (priority, estimate, focus, area) *and*
 * tags travel in the notes footer. That is the difference from the Microsoft
 * mapping, which can put priority in `importance` and tags in `categories`.
 */

/** `yyyy-MM-dd` -> RFC3339. UTC midnight matches how Google stores due dates. */
export function toGoogleDue(dueDate: string | undefined): string | undefined {
  return dueDate ? `${dueDate}T00:00:00.000Z` : undefined;
}

/** Reads back only the calendar date; Google ignores the time it echoes. */
export function fromGoogleDue(due: string | undefined): string | undefined {
  if (!due) return undefined;
  const date = due.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;
}

export function toGoogleTask(task: Task): GoogleTaskWrite {
  const done = task.status === 'done';
  return {
    title: task.title,
    notes: joinBody(task.notes ?? '', {
      estimateMin: task.estimateMin,
      focusLevel: task.focusLevel,
      priority: task.priority,
      domain: task.domain,
      context: task.context,
      startDate: task.startDate,
      blockedNote: task.blockedNote,
      tags: task.tags ?? [],
    }),
    status: done ? 'completed' : 'needsAction',
    due: toGoogleDue(task.dueDate),
    // Google rejects `completed` unless the task is actually completed.
    completed: done ? new Date(task.completedAt ?? Date.now()).toISOString() : undefined,
  };
}

/**
 * Projects a Google task onto our model. `fallbackDomain` comes from the list's
 * mapped project, so a task created in the Google app lands in a sensible area.
 */
export function fromGoogleTask(
  remote: GoogleTask,
  fallbackDomain: Domain = 'work',
): RemoteTaskFields {
  const { notes, meta } = splitBody(remote.notes);
  const done = remote.status === 'completed';
  const completedAt = remote.completed ? Date.parse(remote.completed) : undefined;

  return {
    title: remote.title?.trim() || '(untitled)',
    notes,
    // Nothing to fall back on: Google has no priority, so unmarked tasks from
    // its own UI land in the middle of the pack rather than jumping the queue.
    priority: meta.priority ?? 3,
    estimateMin: meta.estimateMin ?? 30,
    focusLevel: meta.focusLevel ?? 'medium',
    domain: meta.domain ?? fallbackDomain,
    dueDate: fromGoogleDue(remote.due),
    startDate: meta.startDate,
    context: meta.context,
    blockedNote: meta.blockedNote,
    status: done ? 'done' : 'todo',
    tags: meta.tags ?? [],
    completedAt: done ? (Number.isFinite(completedAt) ? completedAt : Date.now()) : undefined,
  };
}
