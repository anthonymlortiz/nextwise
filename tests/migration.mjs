import { connect, reporter } from './lib.mjs';

const t = await connect();
const r = reporter();
const js = t.js;
const wait = ms => new Promise(z => setTimeout(z, ms));
const eq = (name, actual, expected) =>
  r.ok(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const reload = async () => {
  await t.send('Page.navigate', { url: t.url });
  await wait(2500);
};

// Someone who has been syncing with Microsoft To Do already has remote ids
// stored inline on their tasks and projects. v3 moves that state into
// `syncLinks`; if the upgrade drops it, their next sync duplicates the lot.
r.section('1. Rebuild a v2 database as it existed before multi-provider support');
{
  const built = await js(`(async () => {
    const Dexie = Object.getPrototypeOf(window.__fb.db).constructor;
    await window.__fb.db.close();
    await new Promise((res) => {
      const req = indexedDB.deleteDatabase('ProductivityDB');
      req.onsuccess = res; req.onerror = res; req.onblocked = res;
    });

    const old = new Dexie('ProductivityDB');
    old.version(1).stores({
      tasks: '++id, domain, projectId, status, priority, dueDate, focusLevel, createdAt',
      projects: '++id, domain, archived, name',
    });
    old.version(2).stores({
      tasks: '++id, domain, projectId, status, priority, dueDate, focusLevel, createdAt, updatedAt, remoteId, remoteListId',
      projects: '++id, domain, archived, name, updatedAt, remoteId',
      tombstones: '++id, kind, remoteId',
      syncState: 'key',
    });
    await old.open();

    const pid = await old.table('projects').add({
      name:'Legacy project', domain:'work', color:'#6366f1', archived:0,
      createdAt:1000, updatedAt:2000,
      remoteId:'list-legacy', remoteProvider:'mstodo', syncedAt:3000,
    });
    await old.table('tasks').add({
      title:'Linked task', notes:'', domain:'work', projectId:pid, priority:2,
      estimateMin:30, focusLevel:'medium', status:'todo', tags:[],
      createdAt:1000, updatedAt:2000,
      remoteId:'task-legacy', remoteListId:'list-legacy',
      remoteStamp:'2026-01-01T00:00:00Z', remoteProvider:'mstodo', syncedAt:5000,
    });
    // A task that was never synced must not gain a link.
    await old.table('tasks').add({
      title:'Never synced', notes:'', domain:'personal', priority:3,
      estimateMin:15, focusLevel:'shallow', status:'todo', tags:[],
      createdAt:1000, updatedAt:2000,
    });
    await old.table('tombstones').add({ kind:'task', remoteId:'gone-1', remoteListId:'list-legacy', deletedAt:9000 });
    await old.table('syncState').put({ key:'delta:list-legacy', value:'delta-token' });
    await old.table('syncState').put({ key:'lastSyncAt', value:'12345' });

    const version = old.verno;
    await old.close();
    return { version, projectId: pid };
  })()`);
  eq('seeded at schema version 2', built.version, 2);
}

r.section('2. Opening the app upgrades it to the current schema');
await reload();
{
  const state = await js(`(async () => {
    const { db } = window.__fb;
    await db.open();
    return {
      version: db.verno,
      tasks: await db.tasks.toArray(),
      projects: await db.projects.toArray(),
      links: await db.syncLinks.toArray(),
      tombstones: await db.tombstones.toArray(),
      stateKeys: await db.syncState.toCollection().primaryKeys(),
      graves: await db.graveyard.count(),
    };
  })()`);

  eq('database is now v5', state.version, 5);
  eq('no tasks lost', state.tasks.length, 2);
  eq('no projects lost', state.projects.length, 1);

  // v4 added context, startDate and blockedBy. Absent must keep meaning "no
  // constraint" — a migration that defaulted them would hide old tasks.
  const untouched = state.tasks.every(
    (task) =>
      task.context === undefined &&
      task.startDate === undefined &&
      task.blockedBy === undefined &&
      task.blockedNote === undefined,
  );
  r.ok('v4 fields left absent on existing tasks', untouched, JSON.stringify(state.tasks));

  // v5 added the portable identity the JSON board keys on. A record without one
  // cannot be matched across devices, so the upgrade has to reach every row that
  // predates it — and the ids have to be distinct or two records merge into one.
  const uids = [...state.tasks, ...state.projects].map((r) => r.uid);
  r.ok('every record was given a portable id', uids.every((u) => typeof u === 'string' && u.length > 0), JSON.stringify(uids));
  eq('and no two records share one', new Set(uids).size, uids.length);
  eq('the graveyard starts empty rather than absent', state.graves, 0);

  const taskLink = state.links.find(l => l.kind === 'task');
  const projectLink = state.links.find(l => l.kind === 'project');

  eq('exactly one link per synced record', state.links.length, 2);
  r.ok('task link harvested', !!taskLink, JSON.stringify(state.links));
  eq('task link attributed to Microsoft', taskLink?.provider, 'mstodo');
  eq('task remote id preserved', taskLink?.remoteId, 'task-legacy');
  eq('task remote list preserved', taskLink?.remoteListId, 'list-legacy');
  eq('task change marker preserved', taskLink?.remoteStamp, '2026-01-01T00:00:00Z');
  eq('task sync clock preserved', taskLink?.syncedAt, 5000);

  r.ok('project link harvested', !!projectLink, JSON.stringify(state.links));
  eq('project remote id preserved', projectLink?.remoteId, 'list-legacy');
  eq('project sync clock preserved', projectLink?.syncedAt, 3000);

  const linked = state.tasks.find(t => t.title === 'Linked task');
  const unlinked = state.tasks.find(t => t.title === 'Never synced');
  eq('inline remote id removed from the task', linked?.remoteId, undefined);
  eq('inline remote list removed from the task', linked?.remoteListId, undefined);
  eq('inline stamp removed from the task', linked?.remoteStamp, undefined);
  eq('inline syncedAt removed from the task', linked?.syncedAt, undefined);
  eq('task content untouched', [linked?.title, linked?.priority, linked?.updatedAt], ['Linked task', 2, 2000]);
  r.ok('unsynced task gained no link', !state.links.some(l => l.localId === unlinked?.id), JSON.stringify(state.links));
  eq('inline remote id removed from the project', state.projects[0]?.remoteId, undefined);

  eq('tombstone attributed to Microsoft', state.tombstones[0]?.provider, 'mstodo');
  eq('tombstone target preserved', state.tombstones[0]?.remoteId, 'gone-1');
  eq('un-namespaced cursors dropped', state.stateKeys, []);
}

r.section('3. The migrated links still drive a clean sync');
{
  const res = await js(`(async () => {
    const { db, runSync, msProvider, FakeGraphClient } = window.__fb;
    // A server that already holds the counterparts the migrated links point at.
    const client = new FakeGraphClient({ withDefaultList: true });
    const listId = client.seedList('Legacy project', 'list-legacy');
    client.seedTask(listId, { title: 'Linked task' }, 'task-legacy');
    const result = await runSync(msProvider(client));
    return {
      result,
      remoteTasks: client.taskCount,
      localTasks: await db.tasks.count(),
      lists: client.listNames(),
      links: await db.syncLinks.count(),
    };
  })()`);

  r.ok('sync succeeded', res.result.ok === true, JSON.stringify(res.result.errors));
  eq('existing remote task was recognised, not duplicated', res.remoteTasks, 2);
  eq('local board unchanged', res.localTasks, 2);
  eq('legacy list reused rather than recreated', res.lists.filter(n => n === 'Legacy project').length, 1);
  r.ok('only the never-synced task was pushed', res.result.pushed.created === 1,
    JSON.stringify(res.result.pushed));
  eq('tombstone replayed and cleared', await js(`window.__fb.db.tombstones.count()`), 0);
  eq('links intact after syncing', res.links, 3);
}

r.section('4. The v4 indexes work on an upgraded database');
{
  const idx = await js(`(async () => {
    const { db } = window.__fb;
    const [a, b] = await db.tasks.toArray();
    await db.tasks.update(a.id, { context: 'phone', startDate: '2099-01-01' });
    await db.tasks.update(b.id, { blockedBy: a.id });
    return {
      byContext: (await db.tasks.where('context').equals('phone').toArray()).map(t => t.title),
      byStart: (await db.tasks.where('startDate').equals('2099-01-01').count()),
      // The query App.deleteTask relies on to release dependents.
      dependents: (await db.tasks.where('blockedBy').equals(a.id).toArray()).map(t => t.title),
    };
  })()`);
  eq('context is queryable', idx.byContext, ['Linked task']);
  eq('startDate is queryable', idx.byStart, 1);
  eq('dependents are findable by blocker', idx.dependents, ['Never synced']);
}

// Leave a clean database behind so the other suites are not affected.
await js(`(async () => {
  const { db } = window.__fb;
  await db.tasks.clear(); await db.projects.clear();
  await db.tombstones.clear(); await db.syncState.clear(); await db.syncLinks.clear();
  return 'ok';
})()`);

const okAll = r.done(t.errors);
t.close();
process.exit(okAll ? 0 : 1);
