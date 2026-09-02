import { db } from '../db';
import { recordGrave } from '../backup/store';
import type { Domain, Project, ProviderId, SyncLink, Task } from '../types';
import {
  clearTaskLinksInList,
  deleteLink,
  getLink,
  getLinkByRemote,
  hasLocalEdits,
  linkMap,
  linksForRecord,
  putLink,
} from './links';
import { isMissing, type RemoteList, type RemoteTask, type SyncProvider } from './provider';

export interface SyncCounts {
  created: number;
  updated: number;
  deleted: number;
}

export interface SyncResult {
  ok: boolean;
  startedAt: number;
  finishedAt: number;
  pulled: SyncCounts;
  pushed: SyncCounts;
  conflicts: number;
  errors: string[];
}

const emptyCounts = (): SyncCounts => ({ created: 0, updated: 0, deleted: 0 });

/** Name used when the account has no built-in list to borrow as an inbox. */
export const INBOX_LIST_NAME = 'Nextwise';

/**
 * The app used to publish its inbox under a different name. Keep recognising it,
 * or an account synced by an older build gets that list re-imported as a project.
 */
const LEGACY_INBOX_NAMES = ['Focus Board'];

// State keys are namespaced per provider so two providers never share a cursor.
const cursorKey = (provider: ProviderId, listId: string) => `${provider}:cursor:${listId}`;
export const lastSyncKey = (provider: ProviderId) => `${provider}:lastSyncAt`;

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function getState(key: string): Promise<string | undefined> {
  return (await db.syncState.get(key))?.value;
}

async function setState(key: string, value: string): Promise<void> {
  await db.syncState.put({ key, value });
}

/**
 * Two-way sync between the local store and one remote provider.
 *
 * The algorithm itself is provider-agnostic — everything service-specific sits
 * behind `SyncProvider`. Running it once per provider mirrors the same board to
 * both, because every piece of link state is keyed by provider id.
 *
 * Conflicts are resolved last-write-wins by comparing the provider's change
 * marker against the local `updatedAt` clock. That is the pragmatic choice for
 * a single-user tool, but a badly skewed device clock can lose an edit, so the
 * count is reported back to the UI.
 */
export async function runSync(provider: SyncProvider): Promise<SyncResult> {
  const startedAt = Date.now();
  const result: SyncResult = {
    ok: true,
    startedAt,
    finishedAt: startedAt,
    pulled: emptyCounts(),
    pushed: emptyCounts(),
    conflicts: 0,
    errors: [],
  };

  try {
    const pending = await pushDeletions(provider, result);
    const { inboxListId, listForProject } = await reconcileLists(provider, result, pending);
    await syncTasks(provider, result, inboxListId, listForProject, pending);
    await setState(lastSyncKey(provider.id), String(Date.now()));
  } catch (err) {
    result.ok = false;
    result.errors.push(describe(err));
  }

  result.finishedAt = Date.now();
  return result;
}

/**
 * Remote records this run failed to delete, so the pull can leave them alone.
 *
 * A deletion that could not be pushed is not finished: the local record is
 * already gone, its link with it, so the pull phase would meet the surviving
 * server copy as an unrecognised record and create it again. The user would
 * watch a task they deleted come back.
 */
interface PendingDeletions {
  tasks: Set<string>;
  lists: Set<string>;
}

/**
 * Deletions are replayed first so a record deleted locally is removed from the
 * server before the pull phase could see it and helpfully re-create it.
 *
 * Whatever is left standing afterwards is reported back rather than merely
 * logged, because "the delete failed" and "the pull may now resurrect it" are
 * the same event, and the pull is the only place that can act on it.
 */
async function pushDeletions(
  provider: SyncProvider,
  result: SyncResult,
): Promise<PendingDeletions> {
  const tombstones = await db.tombstones.where('provider').equals(provider.id).toArray();
  const pending: PendingDeletions = { tasks: new Set(), lists: new Set() };

  for (const tomb of tombstones) {
    try {
      if (tomb.kind === 'task' && tomb.remoteListId) {
        await provider.deleteTask(tomb.remoteListId, tomb.remoteId);
      } else if (tomb.kind === 'project') {
        await provider.deleteList(tomb.remoteId);
      }
      result.pushed.deleted++;
    } catch (err) {
      // Already gone on the server is a success for our purposes.
      if (!isMissing(err)) {
        result.errors.push(`delete ${tomb.kind} ${tomb.remoteId}: ${describe(err)}`);
        (tomb.kind === 'task' ? pending.tasks : pending.lists).add(tomb.remoteId);
        continue;
      }
    }
    if (tomb.id !== undefined) await db.tombstones.delete(tomb.id);
  }
  return pending;
}

interface ListPlan {
  inboxListId: string;
  /** local project id -> remote list id */
  listForProject: Map<number, string>;
}

/**
 * Maps projects onto remote lists in both directions.
 *
 * On the very first run projects are matched to existing remote lists by name.
 * Without that adoption step a user who already has a "Hiring" list would end
 * up with two of them.
 */
async function reconcileLists(
  provider: SyncProvider,
  result: SyncResult,
  pending: PendingDeletions,
): Promise<ListPlan> {
  const remoteLists = (await provider.listLists()).filter((l) => !l.ignore);
  const byId = new Map(remoteLists.map((l) => [l.id, l]));
  const claimed = new Set<string>();

  // The account's built-in list is a natural home for project-less tasks.
  let inbox: RemoteList | undefined = remoteLists.find((l) => l.isDefault);
  inbox ??= remoteLists.find(
    (l) => l.name === INBOX_LIST_NAME || LEGACY_INBOX_NAMES.includes(l.name),
  );
  if (!inbox) {
    inbox = await provider.createList(INBOX_LIST_NAME);
    result.pushed.created++;
  }
  claimed.add(inbox.id);

  const listForProject = new Map<number, string>();
  const projects = await db.projects.toArray();
  const links = await linkMap(provider.id, 'project');

  for (const project of projects) {
    if (project.id === undefined) continue;
    const link = links.get(project.id);

    // This service doesn't carry projects from this half of the board.
    if (!provider.pushDomains.includes(project.domain)) {
      // Claim the remote list either way, so the orphan-adoption loop below
      // doesn't turn it straight back into a second local project.
      const published =
        link?.remoteId ??
        remoteLists.find((l) => l.name === project.name && !claimed.has(l.id))?.id;
      if (published) claimed.add(published);
      if (link) await withdrawList(provider, result, project.id, link.remoteId);
      continue;
    }

    if (link) {
      const remote = byId.get(link.remoteId);
      if (!remote) {
        // Deleted on the server: unlink so the code below re-creates it rather
        // than silently destroying local tasks that still reference it.
        await deleteLink(provider.id, 'project', project.id);
      } else {
        claimed.add(remote.id);
        if (remote.name !== project.name) {
          if (hasLocalEdits(project, link)) {
            await provider.renameList(remote.id, project.name);
            result.pushed.updated++;
          } else {
            await db.projects.update(project.id, { name: remote.name, updatedAt: Date.now() });
            result.pulled.updated++;
          }
        }
        await putLink({ ...link, syncedAt: Date.now() });
        listForProject.set(project.id, remote.id);
        continue;
      }
    }

    const adopted = remoteLists.find((l) => l.name === project.name && !claimed.has(l.id));
    const target = adopted ?? (await provider.createList(project.name));
    if (!adopted) result.pushed.created++;

    claimed.add(target.id);
    await putLink({
      provider: provider.id,
      kind: 'project',
      localId: project.id,
      remoteId: target.id,
      syncedAt: Date.now(),
    });
    listForProject.set(project.id, target.id);
  }

  // Lists that exist only on the server become local projects.
  for (const remote of remoteLists) {
    if (claimed.has(remote.id)) continue;
    // Unless we are still trying to delete this one. The local project is
    // already gone, so there is nothing to recognise it by, and creating it
    // would undo the deletion the next push is about to retry.
    if (pending.lists.has(remote.id)) continue;

    const now = Date.now();
    const id = (await db.projects.add({
      name: remote.name,
      domain: provider.defaultDomain,
      color: '#6366f1',
      archived: 0,
      createdAt: now,
      updatedAt: now,
    } as Project)) as number;
    await putLink({
      provider: provider.id,
      kind: 'project',
      localId: id,
      remoteId: remote.id,
      syncedAt: now,
    });
    claimed.add(remote.id);
    listForProject.set(id, remote.id);
    result.pulled.created++;
  }

  return { inboxListId: inbox.id, listForProject };
}

/**
 * Takes a list back off a service after it stopped qualifying — because the
 * project moved to the other half of the board. The list goes with its tasks,
 * so their links have to go too. Nothing local is touched.
 */
async function withdrawList(
  provider: SyncProvider,
  result: SyncResult,
  projectId: number,
  remoteListId: string,
): Promise<void> {
  try {
    await provider.deleteList(remoteListId);
    result.pushed.deleted++;
  } catch (err) {
    if (!isMissing(err)) {
      result.errors.push(`withdraw list ${remoteListId}: ${describe(err)}`);
      result.ok = false;
      return;
    }
  }
  await clearTaskLinksInList(provider.id, remoteListId);
  await deleteLink(provider.id, 'project', projectId);
}

/** The task equivalent: remove it from this service, keep it locally. */
async function withdrawTask(
  provider: SyncProvider,
  result: SyncResult,
  link: SyncLink,
): Promise<void> {
  try {
    if (link.remoteListId) await provider.deleteTask(link.remoteListId, link.remoteId);
    result.pushed.deleted++;
  } catch (err) {
    if (!isMissing(err)) {
      result.errors.push(`withdraw task ${link.remoteId}: ${describe(err)}`);
      result.ok = false;
      return;
    }
  }
  await deleteLink(provider.id, 'task', link.localId);
}

async function syncTasks(
  provider: SyncProvider,
  result: SyncResult,
  inboxListId: string,
  listForProject: Map<number, string>,
  pending: PendingDeletions,
): Promise<void> {
  const projects = await db.projects.toArray();
  const domainForList = new Map<string, Domain>();
  for (const p of projects) {
    const listId = p.id !== undefined ? listForProject.get(p.id) : undefined;
    if (listId) domainForList.set(listId, p.domain);
  }

  const listIds = [inboxListId, ...listForProject.values()];
  const seenRemote = new Map<string, RemoteTask>();

  for (const listId of new Set(listIds)) {
    try {
      await pullList(
        provider,
        result,
        listId,
        domainForList.get(listId) ?? provider.defaultDomain,
        seenRemote,
        pending,
      );
    } catch (err) {
      result.errors.push(`pull ${listId}: ${describe(err)}`);
      result.ok = false;
    }
  }

  await pushTasks(provider, result, inboxListId, listForProject, seenRemote);
}

async function pullList(
  provider: SyncProvider,
  result: SyncResult,
  listId: string,
  fallbackDomain: Domain,
  seenRemote: Map<string, RemoteTask>,
  pending: PendingDeletions,
): Promise<void> {
  const stored = await getState(cursorKey(provider.id, listId));
  const page = await provider.changedTasks(listId, stored, fallbackDomain);

  const projectId = (await getLinkByRemote(provider.id, 'project', listId))?.localId;

  /**
   * Local tasks in this list that this provider has no link for, bucketed by
   * title. Built lazily because it only matters when an unlinked remote task
   * turns up — after "reset links", or when the same task was written down in
   * both places. Adopting them is the same rule already used for lists, and it
   * is what stops a reset from duplicating the entire board.
   */
  let adoptable: Map<string, Task[]> | null = null;
  const claimTwin = async (title: string): Promise<Task | undefined> => {
    if (!adoptable) {
      adoptable = new Map();
      const [all, links] = await Promise.all([
        db.tasks.toArray(),
        linkMap(provider.id, 'task'),
      ]);
      for (const t of all) {
        if (t.id === undefined || links.has(t.id)) continue;
        if (t.projectId !== projectId) continue;
        // Adopting a task this service isn't allowed to hold would only get it
        // withdrawn again moments later, deleting the remote copy.
        if (!provider.pushDomains.includes(t.domain)) continue;
        const bucket = adoptable.get(t.title);
        if (bucket) bucket.push(t);
        else adoptable.set(t.title, [t]);
      }
    }
    return adoptable.get(title)?.shift();
  };

  for (const remote of page.tasks) {
    seenRemote.set(remote.id, remote);
    // Still queued for deletion on this service: the local record is gone and
    // its link with it, so every check below would read this as a new task and
    // create it. Skipping it leaves the tombstone for the next run to retry.
    if (pending.tasks.has(remote.id)) continue;
    let link = await getLinkByRemote(provider.id, 'task', remote.id);
    let local = link ? await db.tasks.get(link.localId) : undefined;

    if (remote.removed) {
      if (local?.id !== undefined) {
        // Drop this provider's link first: it already knows the task is gone,
        // so the tombstones below are only for the *other* providers.
        await deleteLink(provider.id, 'task', local.id);
        await recordTombstone('task', local.id);
        // A deletion that arrives from a provider still has to reach the JSON
        // backup, or the next merge would find the task alive in the file and
        // put it back.
        await recordGrave('task', local.uid);
        await db.tasks.delete(local.id);
        result.pulled.deleted++;
      } else if (link?.id !== undefined) {
        await db.syncLinks.delete(link.id);
      }
      continue;
    }
    if (!remote.fields) continue;

    const now = Date.now();

    if (!local) {
      const twin = await claimTwin(remote.fields.title);
      if (twin?.id !== undefined) {
        // Identical content means the two are already reconciled. If they have
        // drifted, leave the link looking stale so the comparison below runs
        // and last-write-wins decides, exactly as for any other edit.
        const identical = provider.matches(twin, remote);
        link = {
          provider: provider.id,
          kind: 'task',
          localId: twin.id,
          remoteId: remote.id,
          remoteListId: listId,
          remoteStamp: identical ? remote.stamp : undefined,
          syncedAt: identical ? now : 0,
        };
        await putLink(link);
        local = twin;
      }
    }

    if (!local) {
      const id = (await db.tasks.add({
        ...remote.fields,
        projectId,
        createdAt: remote.createdAt ?? now,
        updatedAt: now,
      } as Task)) as number;
      await putLink({
        provider: provider.id,
        kind: 'task',
        localId: id,
        remoteId: remote.id,
        remoteListId: listId,
        remoteStamp: remote.stamp,
        syncedAt: now,
      });
      result.pulled.created++;
      continue;
    }

    const remoteChanged = remote.stamp !== link?.remoteStamp;
    const localChanged = hasLocalEdits(local, link);

    if (!remoteChanged) continue;

    if (localChanged) {
      result.conflicts++;
      const remoteTime = Date.parse(remote.stamp ?? '') || 0;
      // Local is newer, so leave the record dirty and let the push phase win.
      if (remoteTime < local.updatedAt) continue;
    }

    await db.tasks.put({ ...local, ...remote.fields, projectId, updatedAt: now });
    await putLink({
      ...(link as SyncLink),
      remoteListId: listId,
      remoteStamp: remote.stamp,
      syncedAt: now,
    });
    result.pulled.updated++;
  }

  if (page.cursor) await setState(cursorKey(provider.id, listId), page.cursor);
}

async function pushTasks(
  provider: SyncProvider,
  result: SyncResult,
  inboxListId: string,
  listForProject: Map<number, string>,
  seenRemote: Map<string, RemoteTask>,
): Promise<void> {
  const tasks = await db.tasks.toArray();

  for (const task of tasks) {
    if (task.id === undefined) continue;

    const link = await getLink(provider.id, 'task', task.id);

    // This service doesn't carry this half of the board.
    if (!provider.pushDomains.includes(task.domain)) {
      if (link) await withdrawTask(provider, result, link);
      continue;
    }

    // A personal task filed under a work project has no list of its own here,
    // because the project was never published; the inbox is its home instead.
    const targetList =
      task.projectId !== undefined
        ? (listForProject.get(task.projectId) ?? inboxListId)
        : inboxListId;
    if (!targetList) {
      result.errors.push(`no remote list for task "${task.title}"`);
      result.ok = false;
      continue;
    }

    try {
      if (!link) {
        const created = await provider.createTask(targetList, task);
        await putLink({
          provider: provider.id,
          kind: 'task',
          localId: task.id,
          remoteId: created.id,
          remoteListId: targetList,
          remoteStamp: created.stamp,
          syncedAt: Date.now(),
        });
        result.pushed.created++;
        continue;
      }

      // Neither service can move a task between lists, so a project change is
      // a delete followed by a create.
      if (link.remoteListId && link.remoteListId !== targetList) {
        try {
          await provider.deleteTask(link.remoteListId, link.remoteId);
        } catch {
          // If it is already gone the re-create below still produces the right state.
        }
        const created = await provider.createTask(targetList, task);
        await putLink({
          ...link,
          remoteId: created.id,
          remoteListId: targetList,
          remoteStamp: created.stamp,
          syncedAt: Date.now(),
        });
        result.pushed.updated++;
        continue;
      }

      if (!hasLocalEdits(task, link)) continue;

      // Skip writes that would be a no-op; keeps repeat syncs quiet.
      const remote = seenRemote.get(link.remoteId);
      if (remote && provider.matches(task, remote)) {
        await putLink({ ...link, syncedAt: Date.now() });
        continue;
      }

      const updated = await provider.updateTask(targetList, link.remoteId, task);
      await putLink({
        ...link,
        remoteListId: targetList,
        remoteStamp: updated.stamp,
        syncedAt: Date.now(),
      });
      result.pushed.updated++;
    } catch (err) {
      result.errors.push(`push "${task.title}": ${describe(err)}`);
      result.ok = false;
    }
  }
}

/**
 * Records a local deletion for every provider the record is linked to, so each
 * one removes its own server copy on its next run. Without this a pull would
 * simply re-create anything deleted while disconnected.
 */
export async function recordTombstone(kind: 'task' | 'project', localId: number): Promise<void> {
  const links = await linksForRecord(kind, localId);
  if (links.length === 0) return;

  await db.tombstones.bulkAdd(
    links.map((link) => ({
      provider: link.provider,
      kind,
      remoteId: link.remoteId,
      remoteListId: link.remoteListId,
      deletedAt: Date.now(),
    })),
  );
  const ids = links.map((l) => l.id).filter((id): id is number => id !== undefined);
  await db.syncLinks.bulkDelete(ids);
}

export async function getLastSyncAt(provider: ProviderId): Promise<number | undefined> {
  const raw = await getState(lastSyncKey(provider));
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Clears one provider's link state so its next run re-adopts and re-pulls
 * everything. Tasks and projects themselves are untouched, as is every link
 * belonging to the other provider.
 */
export async function resetSyncState(provider: ProviderId): Promise<void> {
  await db.transaction('rw', db.tombstones, db.syncState, db.syncLinks, async () => {
    await db.syncLinks.where('provider').equals(provider).delete();
    await db.tombstones.where('provider').equals(provider).delete();
    const keys = await db.syncState.toCollection().primaryKeys();
    const mine = keys.filter((k) => String(k).startsWith(`${provider}:`));
    if (mine.length) await db.syncState.bulkDelete(mine);
  });
}
