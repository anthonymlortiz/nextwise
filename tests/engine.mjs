import { connect, reporter } from './lib.mjs';
const { js, errors, close } = await connect();

const R = reporter();

// Install a page-side harness so each scenario is one round-trip.
await js(`window.__h = (() => {
  const { db, runSync, recordTombstone, FakeGraphClient, FakeGoogleClient,
          msProvider, googleProvider, links } = window.__fb;
  const now = () => Date.now();
  const T = (p={}) => ({ title:'t', notes:'', domain:'work', priority:2, estimateMin:30,
    focusLevel:'medium', status:'todo', tags:[], createdAt:now(), updatedAt:now(), ...p });
  const P = (p={}) => ({ name:'P', domain:'work', color:'#6366f1', archived:0,
    createdAt:now(), updatedAt:now(), ...p });
  return {
    async reset() {
      await db.tasks.clear(); await db.projects.clear();
      await db.tombstones.clear(); await db.syncState.clear();
      await db.syncLinks.clear();
    },
    T, P, db, recordTombstone, FakeGraphClient, FakeGoogleClient,
    // A local edit has to land in a strictly later millisecond than the sync
    // before it: \`hasLocalEdits\` is \`updatedAt > syncedAt\`, strict so that a
    // record the pull just wrote isn't echoed straight back. An edit made in
    // the same millisecond reads as clean and proves nothing.
    async settle() { await new Promise(r => setTimeout(r, 3)); },
    async edit(id, patch) {
      await this.settle();
      await db.tasks.update(id, { ...patch, updatedAt: Date.now() });
    },
    // Remote link state now lives in syncLinks rather than on the record.
    async link(kind, localId, provider='mstodo') { return links.getLink(provider, kind, localId); },
    sync(client) { return runSync(msProvider(client)); },
    gsync(client) { return runSync(googleProvider(client)); },
    async tasks() { return db.tasks.toArray(); },
    async projects() { return db.projects.toArray(); },
    async byTitle(t) { return (await db.tasks.toArray()).find(x => x.title === t); },
  };
})(); 'ready'`);

const run = async (body) => js(`(async () => { const h = window.__h; ${body} })()`);

R.section('1. First sync pushes local data to an empty account');
{
  const r = await run(`
    await h.reset();
    const pid = await h.db.projects.add(h.P({name:'Hiring'}));
    await h.db.tasks.add(h.T({title:'Screen resumes', projectId:pid, priority:1, estimateMin:45, focusLevel:'deep', tags:['hr'], dueDate:'2026-04-01'}));
    await h.db.tasks.add(h.T({title:'Inbox zero', estimateMin:15, focusLevel:'shallow', priority:4}));
    const client = new h.FakeGraphClient();
    window.__client = client;
    const res = await h.sync(client);
    return { res, lists: client.listNames(), taskCount: client.taskCount,
      remote: client.findTaskByTitle('Screen resumes'),
      inboxTasks: client.tasksInList(client.findListByName('Tasks').id).map(t=>t.title) };
  `);
  R.ok('sync ok', r.res.ok === true, JSON.stringify(r.res.errors));
  R.ok('created list for project', r.lists.includes('Hiring'), r.lists.join(','));
  R.ok('reused built-in default list as inbox', r.lists.includes('Tasks'), r.lists.join(','));
  R.ok('no stray inbox list', !r.lists.includes('Nextwise'), r.lists.join(','));
  R.ok('both tasks pushed', r.taskCount === 2, String(r.taskCount));
  R.ok('project-less task went to inbox', r.inboxTasks.includes('Inbox zero'), JSON.stringify(r.inboxTasks));
  R.ok('pushed.created counts 2 tasks + 1 list', r.res.pushed.created === 3, JSON.stringify(r.res.pushed));
  R.ok('importance mapped from P1', r.remote.importance === 'high', r.remote.importance);
  R.ok('due date pushed', r.remote.dueDateTime?.dateTime?.startsWith('2026-04-01'), JSON.stringify(r.remote.dueDateTime));
  R.ok('tags -> categories', JSON.stringify(r.remote.categories) === '["hr"]', JSON.stringify(r.remote.categories));
  R.ok('footer carries est+focus', /\[fb\] est=45m focus=deep prio=P1 area=work/.test(r.remote.body.content), r.remote.body.content);
}

R.section('2. Re-syncing immediately is a no-op');
{
  const r = await run(`
    const client = window.__client; client.resetCallCounts();
    const res = await h.sync(client);
    return { res, calls: client.calls, taskCount: client.taskCount, local: (await h.tasks()).length };
  `);
  R.ok('no tasks created', r.calls.createTask === 0, JSON.stringify(r.calls));
  R.ok('no tasks updated', r.calls.updateTask === 0, JSON.stringify(r.calls));
  R.ok('no tasks deleted', r.calls.deleteTask === 0, JSON.stringify(r.calls));
  R.ok('no lists created', r.calls.createList === 0, JSON.stringify(r.calls));
  R.ok('remote unchanged', r.taskCount === 2, String(r.taskCount));
  R.ok('local unchanged (no duplicates)', r.local === 2, String(r.local));
  R.ok('result reports nothing done', JSON.stringify(r.res.pushed) === '{"created":0,"updated":0,"deleted":0}', JSON.stringify(r.res.pushed));
}

R.section('3. Local edit is pushed');
{
  const r = await run(`
    const client = window.__client; client.resetCallCounts();
    const t = await h.byTitle('Inbox zero');
    await h.edit(t.id, { title:'Inbox zero!', priority:1, estimateMin:20 });
    const res = await h.sync(client);
    const remote = client.getTask((await h.link('task', t.id)).remoteId);
    return { res, calls: client.calls, remote, count: client.taskCount };
  `);
  R.ok('one update call only', r.calls.updateTask === 1, JSON.stringify(r.calls));
  R.ok('no duplicate created', r.calls.createTask === 0 && r.count === 2, String(r.count));
  R.ok('title pushed', r.remote.title === 'Inbox zero!', r.remote.title);
  R.ok('importance now high', r.remote.importance === 'high', r.remote.importance);
  R.ok('footer updated to est=20m', /est=20m/.test(r.remote.body.content), r.remote.body.content);
}

R.section('4. Remote edit is pulled');
{
  const r = await run(`
    const client = window.__client; client.resetCallCounts();
    const t = await h.byTitle('Inbox zero!');
    client.editTaskRemotely((await h.link('task', t.id)).remoteId, { title:'Renamed in To Do', importance:'low' });
    const res = await h.sync(client);
    const local = await h.db.tasks.get(t.id);
    return { res, local, link: await h.link('task', t.id), calls: client.calls, count: (await h.tasks()).length };
  `);
  R.ok('local title updated', r.local.title === 'Renamed in To Do', r.local.title);
  R.ok('pulled.updated = 1', r.res.pulled.updated === 1, JSON.stringify(r.res.pulled));
  R.ok('no local duplicate', r.count === 2, String(r.count));
  R.ok('no echo write back', r.calls.updateTask === 0, JSON.stringify(r.calls));
  R.ok('local now clean', r.local.updatedAt <= r.link.syncedAt, `u=${r.local.updatedAt} s=${r.link.syncedAt}`);
}

R.section('5. Conflict — remote is newer, remote wins');
{
  const r = await run(`
    await h.reset();
    const id = await h.db.tasks.add(h.T({title:'Conflict A'}));
    const client = new h.FakeGraphClient(); window.__client = client;
    await h.sync(client);
    const t = await h.db.tasks.get(id);
    const rid = (await h.link('task', id)).remoteId;
    // Local edit first, then a later remote edit.
    await h.edit(id, { title:'Local version' });
    await new Promise(r=>setTimeout(r,15));
    client.advanceClock(600000);
    client.editTaskRemotely(rid, { title:'Remote version' });
    const res = await h.sync(client);
    const local = await h.db.tasks.get(id);
    return { res, local, remote: client.getTask(rid) };
  `);
  R.ok('conflict detected', r.res.conflicts === 1, String(r.res.conflicts));
  R.ok('remote won locally', r.local.title === 'Remote version', r.local.title);
  R.ok('remote unchanged', r.remote.title === 'Remote version', r.remote.title);
}

R.section('6. Conflict — local is newer, local wins');
{
  const r = await run(`
    await h.reset();
    const id = await h.db.tasks.add(h.T({title:'Conflict B'}));
    const client = new h.FakeGraphClient(); window.__client = client;
    await h.sync(client);
    const t = await h.db.tasks.get(id);
    const rid = (await h.link('task', id)).remoteId;
    // Remote edit stamped in the past, then a fresh local edit.
    client.advanceClock(-600000);
    client.editTaskRemotely(rid, { title:'Stale remote' });
    await h.edit(id, { title:'Fresh local' });
    const res = await h.sync(client);
    const local = await h.db.tasks.get(id);
    return { res, local, remote: client.getTask(rid) };
  `);
  R.ok('conflict detected', r.res.conflicts === 1, String(r.res.conflicts));
  R.ok('local kept its value', r.local.title === 'Fresh local', r.local.title);
  R.ok('local pushed over remote', r.remote.title === 'Fresh local', r.remote.title);
}

R.section('7. Local delete removes remote and stays deleted');
{
  const r = await run(`
    await h.reset();
    const id = await h.db.tasks.add(h.T({title:'Delete me'}));
    const client = new h.FakeGraphClient(); window.__client = client;
    await h.sync(client);
    const t = await h.db.tasks.get(id);
    await h.recordTombstone('task', id);
    await h.db.tasks.delete(id);
    const res = await h.sync(client);
    const again = await h.sync(client);
    return { res, remoteCount: client.taskCount, localCount: (await h.tasks()).length,
      tombs: (await h.db.tombstones.toArray()).length, afterSecond: (await h.tasks()).length };
  `);
  R.ok('remote deleted', r.remoteCount === 0, String(r.remoteCount));
  R.ok('pushed.deleted = 1', r.res.pushed.deleted === 1, JSON.stringify(r.res.pushed));
  R.ok('tombstone consumed', r.tombs === 0, String(r.tombs));
  R.ok('does not resurrect on next sync', r.afterSecond === 0, String(r.afterSecond));
}

R.section('8. Remote delete removes the local copy');
{
  const r = await run(`
    await h.reset();
    const id = await h.db.tasks.add(h.T({title:'Killed remotely'}));
    const client = new h.FakeGraphClient(); window.__client = client;
    await h.sync(client);
    const link = await h.link('task', id);
    await client.deleteTask(link.remoteListId, link.remoteId);
    const res = await h.sync(client);
    return { res, localCount: (await h.tasks()).length };
  `);
  R.ok('local deleted', r.localCount === 0, String(r.localCount));
  R.ok('pulled.deleted = 1', r.res.pulled.deleted === 1, JSON.stringify(r.res.pulled));
}

R.section('9. Task created in To Do appears locally with defaults');
{
  const r = await run(`
    await h.reset();
    const client = new h.FakeGraphClient(); window.__client = client;
    await h.sync(client);
    const inbox = client.findListByName('Tasks').id;
    client.seedTask(inbox, { title:'From phone', importance:'high', categories:['errand'],
      dueDateTime:{dateTime:'2026-07-07T00:00:00.0000000',timeZone:'UTC'} });
    const res = await h.sync(client);
    const local = await h.byTitle('From phone');
    return { res, local, count: (await h.tasks()).length };
  `);
  R.ok('created locally', !!r.local, 'not found');
  R.ok('pulled.created = 1', r.res.pulled.created === 1, JSON.stringify(r.res.pulled));
  R.ok('priority from importance', r.local.priority === 2, String(r.local.priority));
  R.ok('default estimate 30m', r.local.estimateMin === 30, String(r.local.estimateMin));
  R.ok('default focus medium', r.local.focusLevel === 'medium', r.local.focusLevel);
  R.ok('due date pulled', r.local.dueDate === '2026-07-07', String(r.local.dueDate));
  R.ok('categories -> tags', JSON.stringify(r.local.tags) === '["errand"]', JSON.stringify(r.local.tags));
  R.ok('no duplicate on second sync', r.count === 1, String(r.count));
}

R.section('10. New list in To Do becomes a project');
{
  const r = await run(`
    await h.reset();
    const client = new h.FakeGraphClient(); window.__client = client;
    await h.sync(client);
    const lid = client.seedList('Renovation');
    client.seedTask(lid, { title:'Pick tiles' });
    const res = await h.sync(client);
    const projects = await h.projects();
    const task = await h.byTitle('Pick tiles');
    return { res, projects: projects.map(p=>p.name), task,
      linked: projects.find(p=>p.name==='Renovation')?.id === task?.projectId };
  `);
  R.ok('project created from list', r.projects.includes('Renovation'), JSON.stringify(r.projects));
  R.ok('task imported', !!r.task, 'missing');
  R.ok('task linked to the new project', r.linked === true, 'not linked');
}

R.section('11. Existing same-named list is adopted, not duplicated');
{
  const r = await run(`
    await h.reset();
    const client = new h.FakeGraphClient(); window.__client = client;
    client.seedList('Hiring');
    await h.db.projects.add(h.P({name:'Hiring'}));
    const res = await h.sync(client);
    const names = client.listNames();
    return { res, names, hiringCount: names.filter(n=>n==='Hiring').length,
      projects: (await h.projects()).filter(p=>p.name==='Hiring').length };
  `);
  R.ok('only one remote Hiring list', r.hiringCount === 1, JSON.stringify(r.names));
  R.ok('only one local Hiring project', r.projects === 1, String(r.projects));
  R.ok('no list created', r.res.pushed.created === 0, JSON.stringify(r.res.pushed));
}

R.section('12. Moving a task between projects moves it between lists');
{
  const r = await run(`
    await h.reset();
    const a = await h.db.projects.add(h.P({name:'Alpha'}));
    const b = await h.db.projects.add(h.P({name:'Beta'}));
    const id = await h.db.tasks.add(h.T({title:'Mover', projectId:a}));
    const client = new h.FakeGraphClient(); window.__client = client;
    await h.sync(client);
    const listA = client.findListByName('Alpha').id, listB = client.findListByName('Beta').id;
    const before = client.tasksInList(listA).map(t=>t.title);
    await h.edit(id, { projectId:b });
    const res = await h.sync(client);
    return { before, afterA: client.tasksInList(listA).map(t=>t.title),
      afterB: client.tasksInList(listB).map(t=>t.title), count: client.taskCount, res };
  `);
  R.ok('started in Alpha', JSON.stringify(r.before) === '["Mover"]', JSON.stringify(r.before));
  R.ok('gone from Alpha', r.afterA.length === 0, JSON.stringify(r.afterA));
  R.ok('now in Beta', JSON.stringify(r.afterB) === '["Mover"]', JSON.stringify(r.afterB));
  R.ok('not duplicated', r.count === 1, String(r.count));
}

R.section('13. Full round-trip preserves rich metadata through the server');
{
  const r = await run(`
    await h.reset();
    const id = await h.db.tasks.add(h.T({title:'Rich', notes:'Some prose.', priority:1,
      estimateMin:90, focusLevel:'deep', domain:'personal', tags:['a','b'], dueDate:'2026-09-09'}));
    const client = new h.FakeGraphClient(); window.__client = client;
    await h.sync(client);
    const before = await h.db.tasks.get(id);
    // Wipe locally, then re-pull everything from the server as a fresh device.
    await h.db.tasks.clear(); await h.db.syncState.clear(); await h.db.syncLinks.clear();
    await h.sync(client);
    const after = await h.byTitle('Rich');
    return { before, after };
  `);
  const fields = ['title','notes','priority','estimateMin','focusLevel','domain','dueDate','status'];
  for (const f of fields) {
    R.ok(`${f} survived server round-trip`, JSON.stringify(r.before[f]) === JSON.stringify(r.after[f]),
      `before=${JSON.stringify(r.before[f])} after=${JSON.stringify(r.after[f])}`);
  }
  R.ok('tags survived', JSON.stringify(r.after.tags) === '["a","b"]', JSON.stringify(r.after.tags));
  R.ok('notes have no footer leakage', !/\[fb\]/.test(r.after.notes), r.after.notes);
}

const passed = R.done(errors);
close();
process.exit(passed ? 0 : 1);
