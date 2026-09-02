import Dexie, { type EntityTable } from 'dexie';
import type { Grave, Project, SyncLink, SyncStateRow, Task, Tombstone } from './types';
import { addDays, todayISO } from './dates';

const db = new Dexie('ProductivityDB') as Dexie & {
  tasks: EntityTable<Task, 'id'>;
  projects: EntityTable<Project, 'id'>;
  tombstones: EntityTable<Tombstone, 'id'>;
  syncState: EntityTable<SyncStateRow, 'key'>;
  syncLinks: EntityTable<SyncLink, 'id'>;
  graveyard: EntityTable<Grave, 'id'>;
};

/**
 * A device-independent identifier for a record.
 *
 * `crypto.randomUUID` needs a secure context, which the app always has in
 * practice (HTTPS, or localhost in development). The fallback exists so a
 * plain-HTTP dev server can still create records rather than throwing.
 */
export function newUid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

db.version(1).stores({
  tasks: '++id, domain, projectId, status, priority, dueDate, focusLevel, createdAt',
  projects: '++id, domain, archived, name',
});

db.version(2)
  .stores({
    tasks:
      '++id, domain, projectId, status, priority, dueDate, focusLevel, createdAt, updatedAt, remoteId, remoteListId',
    projects: '++id, domain, archived, name, updatedAt, remoteId',
    tombstones: '++id, kind, remoteId',
    syncState: 'key',
  })
  .upgrade(async (tx) => {
    // Pre-sync records have no modification clock; treat creation as the last edit
    // so nothing is mistaken for a pending local change on the first sync.
    const stamp = (obj: { createdAt?: number }) => obj.createdAt ?? Date.now();
    await tx
      .table('tasks')
      .toCollection()
      .modify((task) => {
        task.updatedAt ??= stamp(task);
      });
    await tx
      .table('projects')
      .toCollection()
      .modify((project) => {
        project.updatedAt ??= stamp(project);
      });
  });

/**
 * v3 moves remote link state off the records themselves and into `syncLinks`.
 * Keeping `remoteId` inline only worked while there was one provider; syncing
 * to Microsoft *and* Google at once needs one link row per provider.
 */
db.version(3)
  .stores({
    tasks:
      '++id, domain, projectId, status, priority, dueDate, focusLevel, createdAt, updatedAt',
    projects: '++id, domain, archived, name, updatedAt',
    tombstones: '++id, provider, kind, [provider+kind]',
    syncState: 'key',
    syncLinks:
      '++id, &[provider+kind+localId], &[provider+kind+remoteId], [provider+kind], localId, provider',
  })
  .upgrade(async (tx) => {
    const links: SyncLink[] = [];

    const harvest = async (table: 'tasks' | 'projects', kind: 'task' | 'project') => {
      await tx
        .table(table)
        .toCollection()
        .modify((row: Record<string, unknown>) => {
          if (typeof row.remoteId === 'string' && typeof row.id === 'number') {
            links.push({
              provider: 'mstodo',
              kind,
              localId: row.id,
              remoteId: row.remoteId,
              remoteListId: row.remoteListId as string | undefined,
              remoteStamp: row.remoteStamp as string | undefined,
              syncedAt: (row.syncedAt as number | undefined) ?? 0,
            });
          }
          delete row.remoteId;
          delete row.remoteListId;
          delete row.remoteStamp;
          delete row.remoteProvider;
          delete row.syncedAt;
        });
    };

    await harvest('tasks', 'task');
    await harvest('projects', 'project');
    if (links.length) await tx.table('syncLinks').bulkAdd(links);

    // Existing tombstones predate multi-provider support, so they can only be
    // Microsoft ones, and delta cursors are re-keyed by provider from here on.
    await tx
      .table('tombstones')
      .toCollection()
      .modify((row: Record<string, unknown>) => {
        row.provider ??= 'mstodo';
      });
    await tx.table('syncState').clear();
  });

/**
 * v4 adds the three fields that decide whether a task can be started at all:
 * where you have to be (`context`), the earliest date it makes sense to begin
 * (`startDate`), and what it is waiting on (`blockedBy`). No rewriting is
 * needed — for all three, absent means "no constraint", which is what every
 * existing task should mean.
 *
 * `blockedBy` is indexed so deleting a task can find and release its dependents
 * without scanning the table.
 */
db.version(4).stores({
  tasks:
    '++id, domain, projectId, status, priority, dueDate, startDate, focusLevel, context, blockedBy, createdAt, updatedAt',
  projects: '++id, domain, archived, name, updatedAt',
  tombstones: '++id, provider, kind, [provider+kind]',
  syncState: 'key',
  syncLinks:
    '++id, &[provider+kind+localId], &[provider+kind+remoteId], [provider+kind], localId, provider',
});

/**
 * v5 makes the board portable.
 *
 * Every other identifier here is device-local: `id` is a Dexie auto-increment,
 * so task 5 on a laptop and task 5 on a phone are unrelated records. That is
 * fine while the browser is the only copy, but the moment a board is written to
 * a file that another device reads back, records have to be recognisable across
 * installs. `uid` is that identity, and it is the key everything in
 * `src/backup` merges on.
 *
 * `graveyard` is its necessary other half. A deletion is invisible in a
 * snapshot of what still exists, so without a record of it, every merge would
 * see the surviving copy on the other device and faithfully restore what the
 * user just deleted.
 */
db.version(5)
  .stores({
    tasks:
      '++id, &uid, domain, projectId, status, priority, dueDate, startDate, focusLevel, context, blockedBy, createdAt, updatedAt',
    projects: '++id, &uid, domain, archived, name, updatedAt',
    graveyard: '++id, &[kind+uid], deletedAt',
  })
  .upgrade(async (tx) => {
    // Backfilled rather than left undefined: a unique index tolerates many
    // missing values, but every merge would then have nothing to match on and
    // would treat each record as new on both sides.
    for (const table of ['tasks', 'projects']) {
      await tx
        .table(table)
        .toCollection()
        .modify((row: Record<string, unknown>) => {
          row.uid ??= newUid();
        });
    }
  });

/**
 * A record without a `uid` is invisible to every merge, so this is enforced at
 * the table rather than left to each caller. It matters most for the paths that
 * don't write a literal: importing a backup file written before uids existed,
 * and the demo seed.
 */
for (const table of [db.tasks, db.projects]) {
  table.hook('creating', (_key, obj: { uid?: string }) => {
    if (!obj.uid) obj.uid = newUid();
  });
}

const PALETTE = [
  '#6366f1',
  '#ec4899',
  '#14b8a6',
  '#f59e0b',
  '#8b5cf6',
  '#ef4444',
  '#06b6d4',
  '#84cc16',
];

export function nextColor(index: number): string {
  return PALETTE[index % PALETTE.length];
}

export { PALETTE };

let seedPromise: Promise<void> | null = null;

/**
 * Marks a record as demo data rather than the user's own.
 *
 * The example records carry stable, derived uids instead of random ones so that
 * every device seeds *the same* four projects and eight tasks. Random uids made
 * each device's copy a distinct record: connecting a second browser merged a
 * duplicate demo board into the real one, and deleting the examples on one
 * device left graves that matched nothing anywhere else. With a stable uid the
 * existing merge rules do the right thing on their own — the same example is
 * the same record everywhere, and deleting it once buries it for good.
 */
export function exampleUid(kind: 'task' | 'project', name: string): string {
  return `example:${kind}:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
}

export function isExampleUid(uid: string): boolean {
  return uid.startsWith('example:');
}

/**
 * Populates a first-run example set so the recommender has something to reason
 * about immediately.
 *
 * "First run" means a database that has just been created, not one that merely
 * looks empty right now. An emptiness test cannot tell the two apart: a user
 * who deletes their last project has an empty board and would be handed the
 * demo set back on the next reload, mixed in with whatever they kept. Dexie
 * fires `populate` once, inside the transaction that creates the database, so
 * the question is answered by construction and cannot be reopened by deleting
 * things.
 *
 * StrictMode double-invokes effects in development, so the module-level promise
 * still dedupes concurrent callers in this tab.
 */
export function seedIfEmpty(): Promise<void> {
  seedPromise ??= db.open().then(() => undefined);
  return seedPromise;
}

db.on('populate', () => {
  // Returned, not fired and forgotten: Dexie runs this inside the transaction
  // that creates the database and only waits for the writes if it is handed
  // the promise. Dropping it on the floor would let the transaction commit
  // while the seed was still being written.
  return runSeed();
});

async function runSeed(): Promise<void> {
  const today = todayISO();
  const iso = (offsetDays: number) => addDays(today, offsetDays);

  const platformId = await db.projects.add({
    uid: exampleUid('project', 'Platform Migration'),
    name: 'Platform Migration',
    domain: 'work',
    color: PALETTE[0],
    archived: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const hiringId = await db.projects.add({
    uid: exampleUid('project', 'Hiring'),
    name: 'Hiring',
    domain: 'work',
    color: PALETTE[2],
    archived: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const homeId = await db.projects.add({
    uid: exampleUid('project', 'Home'),
    name: 'Home',
    domain: 'personal',
    color: PALETTE[3],
    archived: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const healthId = await db.projects.add({
    uid: exampleUid('project', 'Health'),
    name: 'Health',
    domain: 'personal',
    color: PALETTE[4],
    archived: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  const samples: Omit<Task, 'id' | 'uid'>[] = [
    {
      title: 'Write migration design doc',
      notes: 'Cover rollback strategy and data backfill.',
      domain: 'work',
      projectId: platformId,
      priority: 1,
      estimateMin: 90,
      focusLevel: 'deep',
      dueDate: iso(2),
      context: 'laptop',
      status: 'todo',
      tags: ['writing'],
      createdAt: Date.now() - 86400000 * 4,
      updatedAt: Date.now() - 86400000 * 4,
    },
    {
      title: 'Review PR #482',
      notes: '',
      domain: 'work',
      projectId: platformId,
      priority: 2,
      estimateMin: 30,
      focusLevel: 'medium',
      dueDate: iso(0),
      context: 'laptop',
      status: 'todo',
      tags: ['review'],
      createdAt: Date.now() - 86400000,
      updatedAt: Date.now() - 86400000,
    },
    {
      title: 'Clear inbox and triage tickets',
      notes: '',
      domain: 'work',
      priority: 4,
      estimateMin: 15,
      focusLevel: 'shallow',
      context: 'laptop',
      status: 'todo',
      tags: ['admin'],
      createdAt: Date.now() - 86400000 * 9,
      updatedAt: Date.now() - 86400000 * 9,
    },
    {
      title: 'Screen 3 candidate resumes',
      notes: '',
      domain: 'work',
      projectId: hiringId,
      priority: 2,
      estimateMin: 45,
      focusLevel: 'medium',
      dueDate: iso(-1),
      context: 'laptop',
      status: 'todo',
      tags: [],
      createdAt: Date.now() - 86400000 * 3,
      updatedAt: Date.now() - 86400000 * 3,
    },
    {
      title: 'Book dentist appointment',
      notes: '',
      domain: 'personal',
      projectId: healthId,
      priority: 3,
      estimateMin: 10,
      focusLevel: 'shallow',
      dueDate: iso(1),
      context: 'phone',
      status: 'todo',
      tags: ['errand'],
      createdAt: Date.now() - 86400000 * 12,
      updatedAt: Date.now() - 86400000 * 12,
    },
    {
      // Shows what "blocked" looks like: real, open, and deliberately absent
      // from today's recommendations until the note is cleared.
      title: 'Fix leaking kitchen tap',
      notes: '',
      domain: 'personal',
      projectId: homeId,
      priority: 2,
      estimateMin: 60,
      focusLevel: 'medium',
      context: 'home',
      blockedNote: 'the replacement washer arriving',
      status: 'todo',
      tags: [],
      createdAt: Date.now() - 86400000 * 6,
      updatedAt: Date.now() - 86400000 * 6,
    },
    {
      title: 'Plan next quarter training block',
      notes: '',
      domain: 'personal',
      projectId: healthId,
      priority: 3,
      estimateMin: 40,
      focusLevel: 'deep',
      context: 'laptop',
      status: 'todo',
      tags: [],
      createdAt: Date.now() - 86400000 * 2,
      updatedAt: Date.now() - 86400000 * 2,
    },
    {
      // And what "not before" looks like: nothing to do about it this week,
      // so it stays out of the way until it can actually be started.
      title: 'Return the parcel to the post office',
      notes: '',
      domain: 'personal',
      priority: 3,
      estimateMin: 20,
      focusLevel: 'shallow',
      dueDate: iso(9),
      startDate: iso(3),
      context: 'errand',
      status: 'todo',
      tags: [],
      createdAt: Date.now() - 86400000,
      updatedAt: Date.now() - 86400000,
    },
  ];

  await db.tasks.bulkAdd(samples.map((task) => ({ ...task, uid: exampleUid('task', task.title) })));
}

export { db };
