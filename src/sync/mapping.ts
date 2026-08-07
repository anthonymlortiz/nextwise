import type { Domain, Priority, Task } from '../types';
import type { GraphImportance, GraphTaskWrite, GraphTodoTask } from './graphTypes';
import { joinBody, splitBody } from './footer';
import type { RemoteTaskFields } from './provider';

/**
 * P1/P2 both surface as "important" in To Do, which is the only distinction its
 * UI offers. The footer carries the exact level, so this mapping is a display
 * convenience rather than the source of truth.
 */
export function priorityToImportance(priority: Priority): GraphImportance {
  if (priority <= 2) return 'high';
  if (priority === 3) return 'normal';
  return 'low';
}

/** Only used for tasks authored in To Do, which carry no footer. */
export function importanceToPriority(importance: GraphImportance | undefined): Priority {
  if (importance === 'high') return 2;
  if (importance === 'low') return 4;
  return 3;
}

/** `yyyy-MM-dd` -> Graph date-time. UTC midnight avoids timezone drift. */
export function toGraphDue(dueDate: string | undefined) {
  if (!dueDate) return null;
  return { dateTime: `${dueDate}T00:00:00.0000000`, timeZone: 'UTC' };
}

/** Reads back only the calendar date, ignoring any timezone the server echoes. */
export function fromGraphDue(due: GraphTodoTask['dueDateTime']): string | undefined {
  if (!due?.dateTime) return undefined;
  const date = due.dateTime.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;
}

export function toGraphTask(task: Task): GraphTaskWrite {
  return {
    title: task.title,
    body: {
      content: joinBody(task.notes ?? '', {
        estimateMin: task.estimateMin,
        focusLevel: task.focusLevel,
        priority: task.priority,
        domain: task.domain,
        context: task.context,
        startDate: task.startDate,
        blockedNote: task.blockedNote,
      }),
      contentType: 'text',
    },
    importance: priorityToImportance(task.priority),
    status: task.status === 'done' ? 'completed' : 'notStarted',
    categories: task.tags ?? [],
    dueDateTime: toGraphDue(task.dueDate),
  };
}

/**
 * Projects a remote task onto our model. `fallbackDomain` comes from the list's
 * mapped project, so a task created on a phone lands in a sensible area.
 */export function fromGraphTask(
  remote: GraphTodoTask,
  fallbackDomain: Domain = 'work',
): RemoteTaskFields {
  const { notes, meta } = splitBody(remote.body?.content);
  const done = remote.status === 'completed';
  const completedAt = remote.completedDateTime?.dateTime
    ? Date.parse(remote.completedDateTime.dateTime)
    : undefined;

  return {
    title: remote.title ?? '(untitled)',
    notes,
    priority: meta.priority ?? importanceToPriority(remote.importance),
    estimateMin: meta.estimateMin ?? 30,
    focusLevel: meta.focusLevel ?? 'medium',
    domain: meta.domain ?? fallbackDomain,
    dueDate: fromGraphDue(remote.dueDateTime),
    startDate: meta.startDate,
    context: meta.context,
    blockedNote: meta.blockedNote,
    status: done ? 'done' : 'todo',
    tags: remote.categories ?? [],
    completedAt: done ? (Number.isFinite(completedAt) ? completedAt : Date.now()) : undefined,
  };
}
