import type { Domain, Task } from '../types';
import type { GoogleClient } from './googleTypes';
import { fromGoogleTask, toGoogleTask } from './googleMapping';
import {
  DEFAULT_DOMAIN,
  PUSH_DOMAINS,
  fieldsMatch,
  type RemoteList,
  type RemoteTask,
  type RemoteTaskPage,
  type SyncProvider,
} from './provider';

/**
 * Google has no delta endpoint, so incremental pulls filter on `updatedMin`.
 * That compares the server's clock against a timestamp we captured, so a little
 * rewind on every run stops a task edited during the previous request from
 * slipping through the gap unseen.
 */
const OVERLAP_MS = 60_000;

function rewind(cursor: string | undefined): string | undefined {
  if (!cursor) return undefined;
  const t = Date.parse(cursor);
  return Number.isFinite(t) ? new Date(t - OVERLAP_MS).toISOString() : undefined;
}

/** Adapts the Google Tasks API to the engine's neutral vocabulary. */
export function googleProvider(client: GoogleClient): SyncProvider {
  // Resolved once per sync run: it costs a request and cannot change mid-run.
  let defaultId: string | undefined | null = null;

  return {
    id: 'gtasks',
    label: 'Google Tasks',
    defaultDomain: DEFAULT_DOMAIN.gtasks,
    pushDomains: PUSH_DOMAINS.gtasks,

    async listLists(): Promise<RemoteList[]> {
      const [lists, resolvedDefault] = await Promise.all([
        client.listLists(),
        defaultId === null ? client.defaultListId() : Promise.resolve(defaultId),
      ]);
      defaultId = resolvedDefault;

      return lists.map((l) => ({
        id: l.id,
        name: l.title,
        isDefault: l.id === defaultId,
      }));
    },

    async createList(name) {
      const created = await client.createList(name);
      return { id: created.id, name: created.title };
    },

    async renameList(id, name) {
      await client.updateList(id, name);
    },

    deleteList: (id) => client.deleteList(id),

    async changedTasks(
      listId: string,
      cursor: string | undefined,
      fallbackDomain: Domain,
    ): Promise<RemoteTaskPage> {
      const page = await client.listTasks(listId, rewind(cursor));

      return {
        cursor: page.cursor,
        tasks: page.tasks.map((t) => ({
          id: t.id,
          removed: t.deleted === true,
          fields: t.deleted ? undefined : fromGoogleTask(t, fallbackDomain),
          // Google has no etag-per-change we can rely on, but `updated` moves on
          // every edit, which is all the engine needs to spot a remote change.
          stamp: t.updated,
          createdAt: t.updated ? Date.parse(t.updated) : undefined,
        })),
      };
    },

    async createTask(listId: string, task: Task): Promise<RemoteTask> {
      const created = await client.createTask(listId, toGoogleTask(task));
      return { id: created.id, stamp: created.updated };
    },

    async updateTask(listId: string, remoteId: string, task: Task): Promise<RemoteTask> {
      const updated = await client.updateTask(listId, remoteId, toGoogleTask(task));
      return { id: updated.id, stamp: updated.updated };
    },

    deleteTask: (listId, remoteId) => client.deleteTask(listId, remoteId),

    matches: fieldsMatch,
  };
}
