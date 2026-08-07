/**
 * A focus session: one task, one clock, nothing else on screen.
 *
 * Recommending is only half the job — the other half is actually doing the
 * thing — so this module owns the state of "I am working on that right now".
 * It is pure and clock-injectable: every function takes `now`, so the maths can
 * be tested without waiting for real seconds to pass.
 *
 * The session lives in `localStorage`, not IndexedDB. It is ephemeral UI state
 * belonging to this device, and it must survive a reload without the timer
 * jumping — which is why elapsed time is derived from wall-clock stamps rather
 * than counted up by an interval that a background tab would throttle.
 */
import type { ChecklistItem } from './types';

const SESSION_KEY = 'pp.session.v1';

export interface FocusSession {
  taskId: number;
  /** Countdown target in minutes. Grows when the user says it's taking longer. */
  plannedMin: number;
  /** Wall clock at the start of the current run. Meaningless while paused. */
  runStartedAt: number;
  /** Milliseconds banked from previous runs of this session. */
  bankedMs: number;
  paused: boolean;
  /** How many times "this is taking longer" was pressed. */
  extensions: number;
  /** Wall clock when the session first began, for the summary on completion. */
  openedAt: number;
}

export function startSession(taskId: number, plannedMin: number, now: number): FocusSession {
  return {
    taskId,
    plannedMin,
    runStartedAt: now,
    bankedMs: 0,
    paused: false,
    extensions: 0,
    openedAt: now,
  };
}

/** Total time on the clock, whether the session is running or paused. */
export function elapsedMs(s: FocusSession, now: number): number {
  if (s.paused) return s.bankedMs;
  return s.bankedMs + Math.max(0, now - s.runStartedAt);
}

/**
 * Milliseconds left of the plan. Goes negative once the plan is used up, which
 * is what turns the countdown into a count-up rather than freezing it at zero:
 * running over is information, and hiding it would be the one moment the timer
 * had something to say.
 */
export function remainingMs(s: FocusSession, now: number): number {
  return s.plannedMin * 60_000 - elapsedMs(s, now);
}

export function isOvertime(s: FocusSession, now: number): boolean {
  return remainingMs(s, now) < 0;
}

/** 0–1 progress through the plan, clamped so the bar stops at full. */
export function progress(s: FocusSession, now: number): number {
  const total = s.plannedMin * 60_000;
  if (total <= 0) return 1;
  return Math.min(1, elapsedMs(s, now) / total);
}

export function pauseSession(s: FocusSession, now: number): FocusSession {
  if (s.paused) return s;
  return { ...s, paused: true, bankedMs: elapsedMs(s, now) };
}

export function resumeSession(s: FocusSession, now: number): FocusSession {
  if (!s.paused) return s;
  return { ...s, paused: false, runStartedAt: now };
}

/** The default nudge when a task turns out to be bigger than it looked. */
export const EXTEND_MIN = 10;

export function extendSession(s: FocusSession, minutes = EXTEND_MIN): FocusSession {
  return { ...s, plannedMin: s.plannedMin + minutes, extensions: s.extensions + 1 };
}

/** Whole minutes spent, rounded to the nearest minute and never negative. */
export function spentMinutes(s: FocusSession, now: number): number {
  return Math.max(0, Math.round(elapsedMs(s, now) / 60_000));
}

/**
 * `m:ss` under an hour, `h:mm:ss` above it. Deliberately not
 * `formatMinutes`-style ("45m"): a running clock has to show seconds moving or
 * it reads as broken.
 */
export function formatClock(ms: number): string {
  const total = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** The clock face: counts down to zero, then counts up with a leading `+`. */
export function clockLabel(s: FocusSession, now: number): string {
  const left = remainingMs(s, now);
  return left < 0 ? `+${formatClock(left)}` : formatClock(left);
}

let nextChecklistId = 0;

/**
 * Ids only have to be unique within one task's checklist, and the array is
 * rewritten as a whole on every edit, so a counter plus the clock is enough
 * without pulling in a uuid dependency.
 */
export function newChecklistItem(text: string): ChecklistItem {
  nextChecklistId += 1;
  return { id: `c${Date.now().toString(36)}${nextChecklistId.toString(36)}`, text, done: false };
}

export function checklistProgress(items: ChecklistItem[] | undefined): {
  done: number;
  total: number;
} {
  const list = items ?? [];
  return { done: list.filter((i) => i.done).length, total: list.length };
}

/**
 * A session is only valid while its task is still open and still exists. A task
 * completed on another tab, deleted, or pulled as done by a sync must not leave
 * a timer running against nothing.
 */
export function sessionIsStale(task: { status: string } | undefined): boolean {
  return !task || task.status !== 'todo';
}

export function loadSession(): FocusSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<FocusSession>;
    if (typeof parsed.taskId !== 'number' || typeof parsed.plannedMin !== 'number') return null;
    return {
      taskId: parsed.taskId,
      plannedMin: parsed.plannedMin,
      runStartedAt: parsed.runStartedAt ?? Date.now(),
      bankedMs: parsed.bankedMs ?? 0,
      paused: parsed.paused ?? false,
      extensions: parsed.extensions ?? 0,
      openedAt: parsed.openedAt ?? Date.now(),
    };
  } catch {
    return null;
  }
}

export function saveSession(s: FocusSession | null): void {
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    // A full or blocked storage quota must not take the running session down.
  }
}
