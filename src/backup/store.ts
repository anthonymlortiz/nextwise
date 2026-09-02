import { db, isExampleUid, newUid } from '../db';
import type { Project, Task } from '../types';
import {
  buildSnapshot,
  type Snapshot,
  type SnapshotProject,
  type SnapshotTask,
} from './snapshot';

/** The board exactly as it stands in this browser. */
export async function readLocal(now: number): Promise<Snapshot> {
  const [tasks, projects, graves] = await Promise.all([
    db.tasks.toArray(),
    db.projects.toArray(),
    db.graveyard.toArray(),
  ]);
  return buildSnapshot(tasks, projects, graves, now);
}

/**
 * Remembers that a record was deleted here.
 *
 * Called on the delete paths rather than inferred later, because by the time a
 * sync runs the record is gone and there is nothing left to notice.
 */
export async function recordGrave(kind: 'task' | 'project', uid: string): Promise<void> {
  // Checked rather than caught: the unique [kind+uid] index would turn a repeat
  // delete into a constraint error, and swallowing every error here would hide
  // real ones. The first stamp is the honest one, so an existing row wins.
  const existing = await db.graveyard.where('[kind+uid]').equals([kind, uid]).first();
  if (existing) return;
  await db.graveyard.add({ kind, uid, deletedAt: Date.now() });
}

/**
 * Removes the demo board from a device that has never been used for real work.
 *
 * A new browser, device or domain creates a new database, which seeds the
 * examples. Connecting that device to an existing board would merge them
 * upward, where four projects and eight tasks nobody wrote look exactly like
 * work someone added. So they are dropped first — but only while the board is
 * *nothing but* examples. One record of the user's own means this is a real
 * board and the examples on it are theirs to keep or delete.
 *
 * No graves are recorded. A grave would travel to the shared board and delete
 * the same examples on a device where the user had decided to keep them; and
 * if the shared board genuinely holds examples, the merge that follows will
 * hand them back, which is the right answer.
 */
export async function discardUntouchedExamples(): Promise<number> {
  const [tasks, projects] = await Promise.all([db.tasks.toArray(), db.projects.toArray()]);
  const rows = [...tasks, ...projects];
  if (rows.length === 0) return 0;
  if (!rows.every((row) => isExampleUid(row.uid))) return 0;

  const taskIds = tasks.map((t) => t.id).filter((id): id is number => id !== undefined);
  const projectIds = projects.map((p) => p.id).filter((id): id is number => id !== undefined);
  await db.transaction('rw', db.tasks, db.projects, async () => {
    await db.tasks.bulkDelete(taskIds);
    await db.projects.bulkDelete(projectIds);
  });
  return taskIds.length + projectIds.length;
}

function projectRow(snap: SnapshotProject, id?: number): Project {
  return {
    ...(id !== undefined ? { id } : {}),
    uid: snap.uid,
    name: snap.name,
    domain: snap.domain,
    color: snap.color,
    archived: snap.archived,
    createdAt: snap.createdAt,
    updatedAt: snap.updatedAt,
  };
}

function taskRow(snap: SnapshotTask, id: number | undefined, projectId: number | undefined): Task {
  const row: Task = {
    ...(id !== undefined ? { id } : {}),
    uid: snap.uid,
    title: snap.title,
    notes: snap.notes,
    domain: snap.domain,
    priority: snap.priority,
    estimateMin: snap.estimateMin,
    focusLevel: snap.focusLevel,
    status: snap.status,
    tags: snap.tags ?? [],
    createdAt: snap.createdAt,
    updatedAt: snap.updatedAt,
  };
  // Assigned conditionally rather than set to undefined: Dexie indexes the key
  // when it is present, so an explicit undefined pollutes the index.
  if (projectId !== undefined) row.projectId = projectId;
  if (snap.dueDate) row.dueDate = snap.dueDate;
  if (snap.startDate) row.startDate = snap.startDate;
  if (snap.context) row.context = snap.context;
  if (snap.blockedNote) row.blockedNote = snap.blockedNote;
  if (snap.checklist) row.checklist = snap.checklist;
  if (snap.spentMin !== undefined) row.spentMin = snap.spentMin;
  if (snap.completedAt !== undefined) row.completedAt = snap.completedAt;
  return row;
}

/** Ignores `id`, which is local bookkeeping rather than content. */
function same(a: object, b: object): boolean {
  const strip = (o: object) => {
    const { id: _id, ...rest } = o as { id?: number };
    return JSON.stringify(rest, Object.keys(rest).sort());
  };
  return strip(a) === strip(b);
}

export interface ApplyCounts {
  created: number;
  updated: number;
  deleted: number;
}

/**
 * Writes a merged snapshot into the local database.
 *
 * Records are matched on `uid` and keep their existing local `id`, so anything
 * already pointing at them — a focus session, a provider sync link — still
 * resolves afterwards. `updatedAt` is copied across untouched: rewriting it
 * would make every pulled record look freshly edited and bounce straight back
 * out to the other devices.
 */
export async function applySnapshot(snapshot: Snapshot): Promise<ApplyCounts> {
  const counts: ApplyCounts = { created: 0, updated: 0, deleted: 0 };

  await db.transaction('rw', db.tasks, db.projects, db.graveyard, async () => {
    const [localTasks, localProjects] = await Promise.all([
      db.tasks.toArray(),
      db.projects.toArray(),
    ]);
    const projectByUid = new Map(localProjects.map((p) => [p.uid, p]));
    const taskByUid = new Map(localTasks.map((t) => [t.uid, t]));

    const goneProjects = new Set(
      snapshot.deletions.filter((d) => d.kind === 'project').map((d) => d.uid),
    );
    const goneTasks = new Set(snapshot.deletions.filter((d) => d.kind === 'task').map((d) => d.uid));

    for (const uid of goneProjects) {
      const local = projectByUid.get(uid);
      if (local?.id === undefined) continue;
      await db.projects.delete(local.id);
      // A task pointing at the project that just went would otherwise keep a
      // reference nothing satisfies, and show up filed under a list that no
      // longer exists. The snapshot's own copy of the task may be byte-identical
      // to the local one, so the write pass below cannot be relied on to notice.
      await db.tasks
        .where('projectId')
        .equals(local.id)
        .modify((task) => {
          delete task.projectId;
        });
      projectByUid.delete(uid);
      counts.deleted++;
    }
    for (const uid of goneTasks) {
      const local = taskByUid.get(uid);
      if (local?.id === undefined) continue;
      await db.tasks.delete(local.id);
      taskByUid.delete(uid);
      counts.deleted++;
    }

    const projectIdByUid = new Map<string, number>();
    for (const snap of snapshot.projects) {
      const local = projectByUid.get(snap.uid);
      const row = projectRow(snap, local?.id);
      if (!local) {
        projectIdByUid.set(snap.uid, (await db.projects.add(row)) as number);
        counts.created++;
      } else {
        projectIdByUid.set(snap.uid, local.id!);
        if (!same(local, row)) {
          await db.projects.put(row);
          counts.updated++;
        }
      }
    }

    const taskIdByUid = new Map<string, number>();
    for (const snap of snapshot.tasks) {
      const local = taskByUid.get(snap.uid);
      const projectId = snap.projectUid ? projectIdByUid.get(snap.projectUid) : undefined;
      const row = taskRow(snap, local?.id, projectId);
      // `blockedBy` is deliberately left for the second pass: the task it
      // points at may not have been inserted yet, so there is no local id to
      // resolve to on this one.
      if (!local) {
        taskIdByUid.set(snap.uid, (await db.tasks.add(row)) as number);
        counts.created++;
      } else {
        taskIdByUid.set(snap.uid, local.id!);
        if (!same({ ...local, blockedBy: undefined }, row)) {
          await db.tasks.put(row);
          counts.updated++;
        }
      }
    }

    for (const snap of snapshot.tasks) {
      const id = taskIdByUid.get(snap.uid);
      if (id === undefined) continue;
      const blockedBy = snap.blockedByUid ? taskIdByUid.get(snap.blockedByUid) : undefined;
      const current = await db.tasks.get(id);
      if (!current || current.blockedBy === blockedBy) continue;
      if (blockedBy === undefined) await db.tasks.update(id, { blockedBy: undefined });
      else await db.tasks.update(id, { blockedBy });
    }

    // The local list is replaced wholesale so it matches the file: entries the
    // merge pruned past the horizon should not come back on the next run.
    await db.graveyard.clear();
    if (snapshot.deletions.length) {
      await db.graveyard.bulkAdd(
        snapshot.deletions.map((d) => ({ kind: d.kind, uid: d.uid, deletedAt: d.deletedAt })),
      );
    }
  });

  return counts;
}

/**
 * Gives every record a uid if the database predates them.
 *
 * The v5 upgrade covers a database that already existed, and the creating hook
 * covers new rows, so this only matters for a database restored from a backup
 * file written before uids — but a record without one is invisible to every
 * merge, which is a silent way to lose work.
 */
export async function backfillUids(): Promise<number> {
  let fixed = 0;
  await db.transaction('rw', db.tasks, db.projects, async () => {
    for (const table of [db.tasks, db.projects]) {
      const rows = await table.toArray();
      for (const row of rows) {
        if (row.uid || row.id === undefined) continue;
        await table.update(row.id, { uid: newUid() });
        fixed++;
      }
    }
  });
  return fixed;
}
