import type { Domain, Task } from '../types';
import type { GraphClient } from './graphTypes';
import { fromGraphTask, toGraphTask } from './mapping';
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
 * Adapts Microsoft Graph To Do to the engine's neutral vocabulary.
 *
 * The Graph client and field mapping are unchanged; this only translates names
 * and folds Graph's `wellknownListName` into the two flags the engine cares
 * about — which list is the default, and which must be left alone.
 */
export function msProvider(client: GraphClient): SyncProvider {
  return {
    id: 'mstodo',
    label: 'Microsoft To Do',
    defaultDomain: DEFAULT_DOMAIN.mstodo,
    pushDomains: PUSH_DOMAINS.mstodo,

    async listLists(): Promise<RemoteList[]> {
      const lists = await client.listLists();
      return lists.map((l) => ({
        id: l.id,
        name: l.displayName,
        isDefault: l.wellknownListName === 'defaultList',
        // Flagged email is a synthetic list; importing it would pull in mail.
        ignore: l.wellknownListName === 'flaggedEmails',
      }));
    },

    async createList(name) {
      const created = await client.createList(name);
      return { id: created.id, name: created.displayName };
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
      const page = await client.deltaTasks(listId, cursor);
      return {
        cursor: page.deltaLink,
        tasks: page.tasks.map((t) => ({
          id: t.id,
          removed: Boolean(t['@removed']),
          fields: t['@removed'] ? undefined : fromGraphTask(t, fallbackDomain),
          stamp: t.lastModifiedDateTime,
          createdAt: t.createdDateTime ? Date.parse(t.createdDateTime) : undefined,
        })),
      };
    },

    async createTask(listId: string, task: Task): Promise<RemoteTask> {
      const created = await client.createTask(listId, toGraphTask(task));
      return { id: created.id, stamp: created.lastModifiedDateTime };
    },

    async updateTask(listId: string, remoteId: string, task: Task): Promise<RemoteTask> {
      const updated = await client.updateTask(listId, remoteId, toGraphTask(task));
      return { id: updated.id, stamp: updated.lastModifiedDateTime };
    },

    deleteTask: (listId, remoteId) => client.deleteTask(listId, remoteId),

    matches: fieldsMatch,
  };
}
