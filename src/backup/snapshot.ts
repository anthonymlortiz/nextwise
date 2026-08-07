import type {
  ChecklistItem,
  Domain,
  FocusLevel,
  Grave,
  Priority,
  Project,
  Task,
  TaskContext,
  TaskStatus,
} from '../types';

/**
 * The board as a plain, device-independent document.
 *
 * Local numeric ids are deliberately absent. They are Dexie auto-increments, so
 * they mean nothing outside the browser that issued them, and writing them to a
 * shared file would make two devices claim the same identifier for different
 * records. Every reference is carried as a `uid` instead and resolved back to a
 * local id on the way in.
 *
 * Provider sync links are absent for a different reason: they describe a
 * relationship between *one browser* and a remote service, including how far
 * that pair has reconciled. Sharing them would let one device's bookkeeping
 * overwrite another's. A record that arrives here without a link is adopted by
 * the sync engine's twin matching on its next run.
 */
export const SNAPSHOT_APP = 'nextwise';
export const SNAPSHOT_VERSION = 2;

/**
 * How long a deletion is remembered.
 *
 * Deletions can't be kept forever or the file grows without bound, but dropping
 * one too early lets any device that still holds the record restore it. Ninety
 * days is far longer than a device is plausibly offline, and short enough that
 * the list stays small.
 */
export const DELETION_HORIZON_MS = 90 * 24 * 60 * 60 * 1000;

export interface SnapshotProject {
  uid: string;
  name: string;
  domain: Domain;
  color: string;
  archived: 0 | 1;
  createdAt: number;
  updatedAt: number;
}

export interface SnapshotTask {
  uid: string;
  title: string;
  notes: string;
  domain: Domain;
  projectUid?: string;
  priority: Priority;
  estimateMin: number;
  focusLevel: FocusLevel;
  dueDate?: string;
  startDate?: string;
  context?: TaskContext;
  blockedByUid?: string;
  blockedNote?: string;
  checklist?: ChecklistItem[];
  spentMin?: number;
  status: TaskStatus;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface SnapshotDeletion {
  kind: 'task' | 'project';
  uid: string;
  deletedAt: number;
}

export interface Snapshot {
  app: typeof SNAPSHOT_APP;
  version: number;
  savedAt: string;
  projects: SnapshotProject[];
  tasks: SnapshotTask[];
  deletions: SnapshotDeletion[];
}

/** Drops keys whose value is undefined, so the JSON stays free of `"x": null`. */
function compact<T extends object>(obj: T): T {
  for (const key of Object.keys(obj) as (keyof T)[]) {
    if (obj[key] === undefined) delete obj[key];
  }
  return obj;
}

export function buildSnapshot(
  tasks: Task[],
  projects: Project[],
  graves: Grave[],
  now: number,
): Snapshot {
  const projectUid = new Map<number, string>();
  for (const p of projects) if (p.id !== undefined) projectUid.set(p.id, p.uid);
  const taskUid = new Map<number, string>();
  for (const t of tasks) if (t.id !== undefined) taskUid.set(t.id, t.uid);

  return {
    app: SNAPSHOT_APP,
    version: SNAPSHOT_VERSION,
    savedAt: new Date(now).toISOString(),
    projects: projects.map((p) =>
      compact({
        uid: p.uid,
        name: p.name,
        domain: p.domain,
        color: p.color,
        archived: p.archived,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      }),
    ),
    tasks: tasks.map((t) =>
      compact({
        uid: t.uid,
        title: t.title,
        notes: t.notes,
        domain: t.domain,
        // A reference that can't be resolved is dropped rather than carried as
        // a dangling id, which the other device would have no way to read.
        projectUid: t.projectId !== undefined ? projectUid.get(t.projectId) : undefined,
        priority: t.priority,
        estimateMin: t.estimateMin,
        focusLevel: t.focusLevel,
        dueDate: t.dueDate,
        startDate: t.startDate,
        context: t.context,
        blockedByUid: t.blockedBy !== undefined ? taskUid.get(t.blockedBy) : undefined,
        blockedNote: t.blockedNote,
        checklist: t.checklist,
        spentMin: t.spentMin,
        status: t.status,
        tags: t.tags,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        completedAt: t.completedAt,
      }),
    ),
    deletions: graves
      .filter((g) => now - g.deletedAt < DELETION_HORIZON_MS)
      .map((g) => ({ kind: g.kind, uid: g.uid, deletedAt: g.deletedAt })),
  };
}

export function emptySnapshot(now: number): Snapshot {
  return {
    app: SNAPSHOT_APP,
    version: SNAPSHOT_VERSION,
    savedAt: new Date(now).toISOString(),
    projects: [],
    tasks: [],
    deletions: [],
  };
}

/**
 * Picks the surviving version of a record edited on both devices.
 *
 * `updatedAt` decides it, which is last-write-wins at record granularity — the
 * same rule the provider sync already uses, so the app behaves consistently
 * however a change arrives. The stringify tie-break only matters when two edits
 * share a millisecond, and exists because "prefer mine" would leave each device
 * keeping its own copy forever and never converging.
 */
function newer<T extends { updatedAt: number }>(a: T, b: T): T {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  return JSON.stringify(a) >= JSON.stringify(b) ? a : b;
}

function mergeRecords<T extends { uid: string; updatedAt: number }>(mine: T[], theirs: T[]): T[] {
  const out = new Map<string, T>();
  for (const record of mine) out.set(record.uid, record);
  for (const record of theirs) {
    const existing = out.get(record.uid);
    out.set(record.uid, existing ? newer(existing, record) : record);
  }
  return [...out.values()];
}

export interface MergeResult {
  merged: Snapshot;
  /** True when the merge holds something the remote file doesn't yet. */
  remoteStale: boolean;
  /** True when the merge holds something this device doesn't yet. */
  localStale: boolean;
}

/**
 * Combines this device's board with the one in the file.
 *
 * Neither side is authoritative. Every record is taken from whichever side
 * edited it last, so a change made on a phone and a different change made on a
 * laptop both survive — which is the whole point of keeping the board in a file
 * rather than letting the device that syncs last overwrite the other.
 */
export function mergeSnapshots(mine: Snapshot, theirs: Snapshot, now: number): MergeResult {
  const deletions = new Map<string, SnapshotDeletion>();
  for (const d of [...mine.deletions, ...theirs.deletions]) {
    const key = `${d.kind}:${d.uid}`;
    const existing = deletions.get(key);
    if (!existing || d.deletedAt > existing.deletedAt) deletions.set(key, d);
  }

  const survives =
    <T extends { uid: string; updatedAt: number }>(kind: 'task' | 'project') =>
    (record: T) => {
      const key = `${kind}:${record.uid}`;
      const grave = deletions.get(key);
      if (!grave) return true;
      // An edit that lands after the deletion wins: the user has touched the
      // record more recently than they removed it, so keeping it is the
      // faithful reading. The deletion is dropped so the two stop fighting.
      if (record.updatedAt > grave.deletedAt) {
        deletions.delete(key);
        return true;
      }
      return false;
    };

  const projects = mergeRecords(mine.projects, theirs.projects).filter(
    survives<SnapshotProject>('project'),
  );
  const tasks = mergeRecords(mine.tasks, theirs.tasks).filter(survives<SnapshotTask>('task'));

  const liveProjects = new Set(projects.map((p) => p.uid));
  const liveTasks = new Set(tasks.map((t) => t.uid));
  for (const task of tasks) {
    // A reference to something the merge removed would otherwise hide the task
    // behind a blocker that no longer exists.
    if (task.projectUid && !liveProjects.has(task.projectUid)) delete task.projectUid;
    if (task.blockedByUid && !liveTasks.has(task.blockedByUid)) delete task.blockedByUid;
  }

  const merged: Snapshot = {
    app: SNAPSHOT_APP,
    version: SNAPSHOT_VERSION,
    savedAt: new Date(now).toISOString(),
    projects: projects.sort((a, b) => a.uid.localeCompare(b.uid)),
    tasks: tasks.sort((a, b) => a.uid.localeCompare(b.uid)),
    deletions: [...deletions.values()]
      .filter((d) => now - d.deletedAt < DELETION_HORIZON_MS)
      .sort((a, b) => `${a.kind}:${a.uid}`.localeCompare(`${b.kind}:${b.uid}`)),
  };

  return {
    merged,
    remoteStale: !sameBoard(merged, theirs),
    localStale: !sameBoard(merged, mine),
  };
}

/**
 * Compares two snapshots by content, ignoring `savedAt`.
 *
 * Every run rewrites that timestamp, so comparing whole documents would report
 * a difference every time and commit an identical board on every sync.
 */
export function sameBoard(a: Snapshot, b: Snapshot): boolean {
  const strip = (s: Snapshot) =>
    JSON.stringify({
      projects: [...s.projects].sort((x, y) => x.uid.localeCompare(y.uid)),
      tasks: [...s.tasks].sort((x, y) => x.uid.localeCompare(y.uid)),
      deletions: [...s.deletions].sort((x, y) =>
        `${x.kind}:${x.uid}`.localeCompare(`${y.kind}:${y.uid}`),
      ),
    });
  return strip(a) === strip(b);
}

export class SnapshotFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotFormatError';
  }
}

/**
 * Reads a snapshot back, refusing anything that isn't recognisably one.
 *
 * The file lives in a repository the user can edit by hand, so a malformed or
 * unrelated document is a realistic input rather than a theoretical one, and
 * treating it as an empty board would merge that emptiness into a real one.
 */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotFormatError('The file is not valid JSON.');
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new SnapshotFormatError('The file does not contain an object.');
  }
  const doc = raw as Partial<Snapshot>;
  if (doc.app !== SNAPSHOT_APP) {
    throw new SnapshotFormatError('That file was not written by Nextwise.');
  }
  if (!Array.isArray(doc.tasks) || !Array.isArray(doc.projects)) {
    throw new SnapshotFormatError('The file is missing its tasks or projects.');
  }
  if (doc.tasks.some((t) => typeof t?.uid !== 'string')) {
    throw new SnapshotFormatError('Some tasks in the file have no uid.');
  }
  if (doc.projects.some((p) => typeof p?.uid !== 'string')) {
    throw new SnapshotFormatError('Some projects in the file have no uid.');
  }
  return {
    app: SNAPSHOT_APP,
    version: typeof doc.version === 'number' ? doc.version : SNAPSHOT_VERSION,
    savedAt: typeof doc.savedAt === 'string' ? doc.savedAt : new Date(0).toISOString(),
    projects: doc.projects,
    tasks: doc.tasks,
    deletions: Array.isArray(doc.deletions) ? doc.deletions : [],
  };
}
