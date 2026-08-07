/** Top-level life area. Every task and project belongs to exactly one. */
export type Domain = 'work' | 'personal';

/** P1 is most important. Mirrors the familiar Eisenhower-ish 4-level scheme. */
export type Priority = 1 | 2 | 3 | 4;

/**
 * How much cognitive fuel a task burns.
 * - deep: needs uninterrupted concentration (writing, architecture, hard debugging)
 * - medium: normal working attention (code review, planning, meetings prep)
 * - shallow: near-autopilot (expenses, filing, quick replies)
 */
export type FocusLevel = 'deep' | 'medium' | 'shallow';

export type TaskStatus = 'todo' | 'done';

/**
 * One line of a task's checklist.
 *
 * The id is a string rather than an array position so toggling an item is
 * stable while another is being added or removed, and so React keys don't
 * reshuffle mid-session.
 */
export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

/**
 * Where you have to be, or what you need in your hands, to do a task at all.
 *
 * This is the GTD sense of "context" and it is a hard constraint rather than a
 * preference: no amount of free time or focus lets you post a parcel from your
 * desk. Tasks without one are doable anywhere and are never filtered out.
 */
export type TaskContext = 'laptop' | 'phone' | 'home' | 'office' | 'errand';

/** A remote service the board can mirror itself to. */
export type ProviderId = 'mstodo' | 'gtasks';

/**
 * Bookkeeping shared by every record that can be mirrored to a remote provider.
 * `updatedAt` is the local modification clock; comparing it against a link's
 * `syncedAt` is what tells the engine a record has unsent local edits.
 *
 * Remote ids deliberately do *not* live here: a record can be linked to several
 * providers at once, so that state belongs in `SyncLink` rows keyed by provider.
 */
export interface SyncMeta {
  updatedAt: number;
}

/**
 * A record's identity across devices.
 *
 * `id` is a Dexie auto-increment and therefore only means anything inside one
 * browser: two installs both number their first task `1`. `uid` is generated
 * once at creation and travels with the record, so a board written to a file on
 * a laptop can be recognised — rather than duplicated — when a phone reads it
 * back. It is never shown to the user and never sent to Microsoft or Google,
 * which have identifier schemes of their own.
 */
export interface Portable {
  uid: string;
}

/**
 * Ties one local record to its counterpart in one provider. Exactly one row per
 * (provider, kind, localId), and per (provider, kind, remoteId).
 */
export interface SyncLink {
  id?: number;
  provider: ProviderId;
  kind: 'task' | 'project';
  localId: number;
  remoteId: string;
  /** Remote list the task currently lives in; moving lists needs the old one. */
  remoteListId?: string;
  /** Provider's own change marker, used to detect remote-side edits. */
  remoteStamp?: string;
  /** Local clock at the moment local and remote were last reconciled. */
  syncedAt: number;
}

export interface Project extends SyncMeta, Portable {
  id?: number;
  name: string;
  domain: Domain;
  color: string;
  archived: 0 | 1;
  createdAt: number;
}

export interface Task extends SyncMeta, Portable {
  id?: number;
  title: string;
  notes: string;
  domain: Domain;
  projectId?: number;
  priority: Priority;
  /** Estimated effort in minutes. Drives time-budget fitting. */
  estimateMin: number;
  focusLevel: FocusLevel;
  /** ISO yyyy-MM-dd, or undefined when the task has no deadline. */
  dueDate?: string;
  /**
   * Earliest date this can be started — the "not before" of a task you cannot
   * usefully touch yet. Unlike `dueDate` it hides the task rather than
   * promoting it, so a deferred item stops competing for attention today.
   */
  startDate?: string;
  /** What you need to hand to do this at all. Undefined means anywhere. */
  context?: TaskContext;
  /**
   * Another task that must finish first. Local ids only, and deliberately not
   * synced: ids are meaningless in Microsoft To Do or Google Tasks.
   */
  blockedBy?: number;
  /** Free-text "waiting on" when the blocker is not a task on this board. */
  blockedNote?: string;
  /**
   * The steps this task breaks into. Local-only: neither provider has a field
   * that survives a round trip (To Do's checklist items are a separate
   * sub-resource, Google's "subtasks" are top-level tasks), and flattening
   * them into the notes would fight the `[fb]` footer for the same space.
   */
  checklist?: ChecklistItem[];
  /**
   * Minutes actually spent in focus sessions, accumulated across all of them.
   * Local-only, and never used for ranking — it exists so the estimate can be
   * compared against reality.
   */
  spentMin?: number;
  status: TaskStatus;
  tags: string[];
  createdAt: number;
  completedAt?: number;
}

/**
 * Records a local deletion so the next sync can delete the remote counterpart.
 * Without this, a pull would simply re-create anything deleted while offline.
 */
export interface Tombstone {
  id?: number;
  provider: ProviderId;
  kind: 'task' | 'project';
  remoteId: string;
  remoteListId?: string;
  deletedAt: number;
}

/** Key/value bag for sync bookkeeping (delta links, last run, settings). */
export interface SyncStateRow {
  key: string;
  value: string;
}

/**
 * A local deletion, remembered by `uid`.
 *
 * `Tombstone` records a deletion for one *provider*, so it can delete its own
 * server copy, and is discarded once that has happened. A grave outlives that:
 * a file-based backup is a snapshot of what exists, so a deletion leaves no
 * trace in it at all, and any device still holding the record would restore it
 * on the next merge. Keeping the uid and the moment of deletion is what lets a
 * merge tell "this was deleted" apart from "this has not arrived yet".
 */
export interface Grave {
  id?: number;
  kind: 'task' | 'project';
  uid: string;
  deletedAt: number;
}

/**
 * The user's current situation, used to rank what to do next.
 *
 * Named `Situation` rather than `Context` so it cannot be confused with a
 * task's `TaskContext`: one describes the person, the other the task.
 */
export interface Situation {
  availableMin: number;
  focus: FocusLevel;
  domain: Domain | 'both';
  projectId?: number | 'all';
  /** Where the user is right now. `'any'` disables context filtering. */
  context?: TaskContext | 'any';
}

/** One line of the human-readable "why this task" explanation. */
export interface ScoreReason {
  label: string;
  points: number;
}

export interface ScoredTask {
  task: Task;
  score: number;
  reasons: ScoreReason[];
  /** True when the estimate exceeds the time the user actually has. */
  overBudget: boolean;
}

export const PRIORITY_LABEL: Record<Priority, string> = {
  1: 'P1 · Critical',
  2: 'P2 · High',
  3: 'P3 · Medium',
  4: 'P4 · Low',
};

export const FOCUS_LABEL: Record<FocusLevel, string> = {
  deep: 'Deep focus',
  medium: 'Medium focus',
  shallow: 'Shallow / low energy',
};

/** Ordering used to compare "how much focus do I have" against "how much a task needs". */
export const FOCUS_RANK: Record<FocusLevel, number> = {
  shallow: 0,
  medium: 1,
  deep: 2,
};

/** Listed in the order they appear in every picker, roughly desk outwards. */
export const CONTEXTS: TaskContext[] = ['laptop', 'phone', 'home', 'office', 'errand'];

export const CONTEXT_LABEL: Record<TaskContext, string> = {
  laptop: 'At a laptop',
  phone: 'On a phone',
  home: 'At home',
  office: 'At the office',
  errand: 'Out on errands',
};

/** The short form used inline on a task row, where the sentence is already long. */
export const CONTEXT_SHORT: Record<TaskContext, string> = {
  laptop: 'laptop',
  phone: 'phone',
  home: 'home',
  office: 'office',
  errand: 'errand',
};

/** Phrased as the recommender's reason for picking a task, e.g. "Doable at home +10". */
export const CONTEXT_FIT: Record<TaskContext, string> = {
  laptop: 'Doable at your laptop',
  phone: 'Doable from your phone',
  home: 'Doable at home',
  office: 'Doable at the office',
  errand: 'Doable while you are out',
};
