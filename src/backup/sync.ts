import {
  BackupConflictError,
  type FileStore,
} from './github';
import {
  emptySnapshot,
  mergeSnapshots,
  parseSnapshot,
  type Snapshot,
} from './snapshot';
import { applySnapshot, readLocal, type ApplyCounts } from './store';

export interface BackupResult {
  /** What the file taught this device. */
  pulled: ApplyCounts;
  /** Whether the file had to be rewritten. */
  pushed: boolean;
  at: number;
  tasks: number;
  projects: number;
}

/**
 * How many times a write may be re-tried after losing a race.
 *
 * A conflict means the file changed between this run's read and its write, so
 * the answer is always to read it again and merge afresh. Three attempts is
 * generous for two devices; anything beyond that is a signal something else is
 * wrong, and looping forever would be worse than reporting it.
 */
const MAX_ATTEMPTS = 3;

function commitMessage(snapshot: Snapshot): string {
  const tasks = snapshot.tasks.length;
  const open = snapshot.tasks.filter((t) => t.status !== 'done').length;
  return `Nextwise: ${tasks} task${tasks === 1 ? '' : 's'}, ${open} open`;
}

/**
 * One full reconciliation: read the file, merge it with this device's board,
 * write back whichever side is behind.
 *
 * Both directions happen in one pass on purpose. Treating it as a backup —
 * push only — would mean the second device to sync silently discards whatever
 * the first one added, which is the failure this whole feature exists to
 * prevent.
 */
export async function runBackup(store: FileStore, now: number = Date.now()): Promise<BackupResult> {
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const existing = await store.read();
    const theirs = existing ? parseSnapshot(existing.text) : emptySnapshot(now);
    const mine = await readLocal(now);
    const { merged, localStale, remoteStale } = mergeSnapshots(mine, theirs, now);

    const pulled = localStale
      ? await applySnapshot(merged)
      : { created: 0, updated: 0, deleted: 0 };

    if (!remoteStale) {
      return {
        pulled,
        pushed: false,
        at: now,
        tasks: merged.tasks.length,
        projects: merged.projects.length,
      };
    }

    try {
      // Pretty-printed because the whole point of a repository is that a human
      // can read the diff and see what changed.
      await store.write(
        `${JSON.stringify(merged, null, 2)}\n`,
        existing?.sha ?? null,
        commitMessage(merged),
      );
      return {
        pulled,
        pushed: true,
        at: now,
        tasks: merged.tasks.length,
        projects: merged.projects.length,
      };
    } catch (err) {
      if (!(err instanceof BackupConflictError)) throw err;
      lastError = err;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new BackupConflictError('The file kept changing while this was saving.');
}
