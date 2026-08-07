import { db } from '../db';
import type { ProviderId, SyncLink } from '../types';

/**
 * Accessors for the `syncLinks` table.
 *
 * Every read and write is scoped by provider, which is what lets one task be
 * mirrored to Microsoft To Do and Google Tasks simultaneously without the two
 * syncs trampling each other's ids and change markers.
 */

type Kind = SyncLink['kind'];

export async function getLink(
  provider: ProviderId,
  kind: Kind,
  localId: number,
): Promise<SyncLink | undefined> {
  return db.syncLinks.where('[provider+kind+localId]').equals([provider, kind, localId]).first();
}

export async function getLinkByRemote(
  provider: ProviderId,
  kind: Kind,
  remoteId: string,
): Promise<SyncLink | undefined> {
  return db.syncLinks.where('[provider+kind+remoteId]').equals([provider, kind, remoteId]).first();
}

/** All links of one kind for a provider, indexed by local id. */
export async function linkMap(
  provider: ProviderId,
  kind: Kind,
): Promise<Map<number, SyncLink>> {
  const rows = await db.syncLinks.where('[provider+kind]').equals([provider, kind]).toArray();
  return new Map(rows.map((r) => [r.localId, r]));
}

/**
 * Creates or updates the link for one record. The unique compound indexes mean
 * a stale row for the same local record must be replaced rather than added.
 */
export async function putLink(
  link: Omit<SyncLink, 'id'> & { id?: number },
): Promise<void> {
  const existing = await getLink(link.provider, link.kind, link.localId);
  if (existing?.id !== undefined) {
    await db.syncLinks.put({ ...existing, ...link, id: existing.id });
    return;
  }
  // A different local record may already own this remote id (for example after
  // a local delete + remote re-create); drop it so the unique index holds.
  const byRemote = await getLinkByRemote(link.provider, link.kind, link.remoteId);
  if (byRemote?.id !== undefined) await db.syncLinks.delete(byRemote.id);
  await db.syncLinks.add(link as SyncLink);
}

export async function deleteLink(
  provider: ProviderId,
  kind: Kind,
  localId: number,
): Promise<void> {
  const existing = await getLink(provider, kind, localId);
  if (existing?.id !== undefined) await db.syncLinks.delete(existing.id);
}

/** Every provider link for one local record, used when it is deleted. */
export async function linksForRecord(kind: Kind, localId: number): Promise<SyncLink[]> {
  const rows = await db.syncLinks.where('localId').equals(localId).toArray();
  return rows.filter((r) => r.kind === kind);
}

/** Drops all link state for a provider, e.g. when the user disconnects it. */
export async function clearLinks(provider: ProviderId): Promise<void> {
  await db.syncLinks.where('provider').equals(provider).delete();
}

/**
 * Forgets the task links inside one remote list. Used when a list is withdrawn
 * from a service, which takes its tasks down with it.
 */
export async function clearTaskLinksInList(
  provider: ProviderId,
  remoteListId: string,
): Promise<void> {
  const rows = await db.syncLinks.where('[provider+kind]').equals([provider, 'task']).toArray();
  const ids = rows.filter((r) => r.remoteListId === remoteListId).map((r) => r.id);
  for (const id of ids) if (id !== undefined) await db.syncLinks.delete(id);
}

/** True when the record has edits the given link has not pushed yet. */
export function hasLocalEdits(record: { updatedAt: number }, link?: SyncLink): boolean {
  return record.updatedAt > (link?.syncedAt ?? 0);
}
