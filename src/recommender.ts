import {
  CONTEXT_FIT,
  FOCUS_RANK,
  type ScoreReason,
  type ScoredTask,
  type Situation,
  type Task,
} from './types';
import { contextExcludes, indexTasks, isBlocked, isDeferred, type TaskMap } from './availability';
import { todayISO } from './dates';

const PRIORITY_POINTS: Record<number, number> = { 1: 45, 2: 30, 3: 18, 4: 8 };

/** Whole days from today until `iso`. Negative means overdue. */
export function daysUntil(iso: string, now: Date = new Date()): number {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const [y, m, d] = iso.split('-').map(Number);
  const due = new Date(y, m - 1, d);
  return Math.round((due.getTime() - today.getTime()) / 86400000);
}

function urgencyPoints(task: Task, now: Date): number {
  if (!task.dueDate) return 0;
  const days = daysUntil(task.dueDate, now);
  if (days < 0) return 40 + Math.min(-days * 3, 20);
  if (days === 0) return 38;
  if (days === 1) return 26;
  if (days <= 3) return 16;
  if (days <= 7) return 9;
  return 3;
}

/**
 * Rewards tasks that use the available slot well. A task that fills most of the
 * window beats a trivial one, but anything that cannot finish in the window is
 * pushed down hard so it never leads the list.
 */
function timeFitPoints(task: Task, availableMin: number): number {
  if (task.estimateMin > availableMin) {
    const overflow = task.estimateMin - availableMin;
    return -35 - Math.min(overflow / 10, 15);
  }
  const utilization = task.estimateMin / Math.max(availableMin, 1);
  return 8 + 17 * utilization;
}

/**
 * Matching cognitive demand to current capacity is the strongest lever on
 * whether a work session actually succeeds, so mismatches are penalised more
 * than a mere lack of match is rewarded.
 */
function focusPoints(task: Task, focus: Situation['focus']): number {
  const need = FOCUS_RANK[task.focusLevel];
  const have = FOCUS_RANK[focus];
  if (need === have) return 22;
  if (have > need) return 9;
  return -24 * (need - have);
}

/** Small nudge so long-ignored tasks eventually surface instead of rotting. */
function stalenessPoints(task: Task, now: Date): number {
  const ageDays = (now.getTime() - task.createdAt) / 86400000;
  return Math.min(ageDays * 0.6, 12);
}

export function scoreTask(task: Task, ctx: Situation, now: Date = new Date()): ScoredTask {
  const reasons: ScoreReason[] = [];
  const push = (label: string, points: number) => {
    if (Math.abs(points) >= 0.5) reasons.push({ label, points: Math.round(points) });
  };

  const priority = PRIORITY_POINTS[task.priority] ?? 8;
  push(`Priority P${task.priority}`, priority);

  const urgency = urgencyPoints(task, now);
  if (task.dueDate) {
    const days = daysUntil(task.dueDate, now);
    const label =
      days < 0
        ? `Overdue by ${-days}d`
        : days === 0
          ? 'Due today'
          : `Due in ${days}d`;
    push(label, urgency);
  }

  const fit = timeFitPoints(task, ctx.availableMin);
  const overBudget = task.estimateMin > ctx.availableMin;
  push(
    overBudget
      ? `Needs ${task.estimateMin}m, you have ${ctx.availableMin}m`
      : `Fits your ${ctx.availableMin}m window`,
    fit,
  );

  const focus = focusPoints(task, ctx.focus);
  push(
    focus >= 0
      ? `${task.focusLevel} work suits your focus`
      : `${task.focusLevel} work needs more focus than you have`,
    focus,
  );

  const stale = stalenessPoints(task, now);
  push('Waiting a while', stale);

  // Only ever a bonus. Context is enforced as a filter, so a mismatch never
  // reaches here, and a task needing nothing in particular must not be punished
  // for it — otherwise every unlabelled task sinks the moment you set a place.
  const placed = ctx.context && ctx.context !== 'any' && task.context === ctx.context;
  const contextual = placed ? 10 : 0;
  if (placed) push(CONTEXT_FIT[task.context!], contextual);

  const score = priority + urgency + fit + focus + stale + contextual;
  return { task, score, reasons, overBudget };
}

/**
 * Can this task be picked up at all, in this situation, right now?
 *
 * Kept separate from scoring because these are absolutes, not preferences: a
 * blocked task is not "worth fewer points", it is simply not available, and
 * letting it compete on score would eventually float it to the top of a quiet
 * board and send the user off to do something they cannot do.
 */
function isCandidate(task: Task, ctx: Situation, byId: TaskMap, today: string): boolean {
  if (task.status !== 'todo') return false;
  if (ctx.domain !== 'both' && task.domain !== ctx.domain) return false;
  if (ctx.projectId && ctx.projectId !== 'all' && task.projectId !== ctx.projectId) return false;
  if (isBlocked(task, byId)) return false;
  if (isDeferred(task, today)) return false;
  if (contextExcludes(task, ctx.context)) return false;
  return true;
}

export function recommend(
  tasks: Task[],
  ctx: Situation,
  now: Date = new Date(),
): ScoredTask[] {
  const byId = indexTasks(tasks);
  const today = todayISO(now);
  return tasks
    .filter((t) => isCandidate(t, ctx, byId, today))
    .map((t) => scoreTask(t, ctx, now))
    .sort((a, b) => b.score - a.score);
}

/**
 * Why the list is shorter than the board.
 *
 * The whole point of this app is that a ranking is only trustworthy if it can
 * explain itself, and that has to cover what it left out as well as what it put
 * first — "nothing to do" and "nothing you can do *from here*" are very
 * different messages.
 */
export interface Withheld {
  blocked: number;
  deferred: number;
  wrongContext: number;
}

export function withheld(tasks: Task[], ctx: Situation, now: Date = new Date()): Withheld {
  const byId = indexTasks(tasks);
  const today = todayISO(now);
  const counts: Withheld = { blocked: 0, deferred: 0, wrongContext: 0 };

  for (const task of tasks) {
    if (task.status !== 'todo') continue;
    if (ctx.domain !== 'both' && task.domain !== ctx.domain) continue;
    if (ctx.projectId && ctx.projectId !== 'all' && task.projectId !== ctx.projectId) continue;
    // One reason each, in the order the user can act on them: unblocking is a
    // decision, a start date is a wait, and being somewhere else is neither.
    if (isBlocked(task, byId)) counts.blocked++;
    else if (isDeferred(task, today)) counts.deferred++;
    else if (contextExcludes(task, ctx.context)) counts.wrongContext++;
  }
  return counts;
}

export interface SessionPlan {
  items: ScoredTask[];
  usedMin: number;
  leftoverMin: number;
}

/**
 * Greedily packs the highest-scoring tasks that still fit the remaining time.
 * Greedy (rather than optimal knapsack) is deliberate: the ordering must stay
 * predictable and explainable, and estimates are too rough for exact packing to
 * be meaningful.
 */
export function buildSessionPlan(scored: ScoredTask[], availableMin: number): SessionPlan {
  const items: ScoredTask[] = [];
  let remaining = availableMin;

  for (const candidate of scored) {
    if (candidate.overBudget) continue;
    if (candidate.task.estimateMin <= remaining) {
      items.push(candidate);
      remaining -= candidate.task.estimateMin;
    }
    if (remaining <= 4) break;
  }

  return { items, usedMin: availableMin - remaining, leftoverMin: remaining };
}
