/**
 * Deleted records must stay deleted.
 *
 * Every case here is a way a record the user removed came back on its own. They
 * are kept together because they share one cause: something that writes records
 * — the provider pull, or the first-run seed — did not consult what had already
 * been deleted.
 */
import { connect, reporter } from './lib.mjs';
const { js, errors, close, send } = await connect();

const R = reporter();

await js(`window.__h = (() => {
  const { db, runSync, recordTombstone, FakeGraphClient, msProvider, links, backup } = window.__fb;
  const now = () => Date.now();
  const T = (p={}) => ({ title:'t', notes:'', domain:'work', priority:2, estimateMin:30,
    focusLevel:'medium', status:'todo', tags:[], createdAt:now(), updatedAt:now(), ...p });
  const P = (p={}) => ({ name:'P', domain:'work', color:'#6366f1', archived:0,
    createdAt:now(), updatedAt:now(), ...p });
  const file = new backup.FakeGitHubFile();
  return {
    T, P, db, links, backup, recordTombstone, FakeGraphClient, file,
    runBackup() { return backup.runBackup(file, Date.now()); },
    /** Wipes the board without touching the shared file, i.e. a second device. */
    async newDevice() {
      await db.tasks.clear(); await db.projects.clear(); await db.graveyard.clear();
      await db.tombstones.clear(); await db.syncLinks.clear();
    },
    async reset() {
      await db.tasks.clear(); await db.projects.clear();
      await db.tombstones.clear(); await db.syncState.clear();
      await db.syncLinks.clear(); await db.graveyard.clear();
    },
    sync(client) { return runSync(msProvider(client)); },
    async tasks() { return db.tasks.toArray(); },
    async titles() { return (await db.tasks.toArray()).map(t => t.title).sort(); },
    async projectNames() { return (await db.projects.toArray()).map(p => p.name).sort(); },
    // Exactly what the Tasks tab does on delete, minus the confirm dialog.
    async uiDeleteTask(id) {
      const task = await db.tasks.get(id);
      await recordTombstone('task', id);
      await backup.recordGrave('task', task.uid);
      await db.tasks.delete(id);
    },
    async uiDeleteProject(id) {
      const project = await db.projects.get(id);
      await recordTombstone('project', id);
      await backup.recordGrave('project', project.uid);
      await db.projects.delete(id);
    },
  };
})(); 'ready'`);

const run = async (body) => js(`(async () => { const h = window.__h; ${body} })()`);

R.section('1. A task deleted locally stays deleted when the server delete fails');
{
  const r = await run(`
    await h.reset();
    const id = await h.db.tasks.add(h.T({title:'Ghost'}));
    const client = new h.FakeGraphClient();
    await h.sync(client);

    await h.uiDeleteTask(id);

    // The server copy cannot be removed: offline, rate-limited, token expired.
    // Anything that is not "already gone" leaves the remote record standing.
    const realDelete = client.deleteTask.bind(client);
    client.deleteTask = async () => { throw new Error('network unreachable'); };
    const res = await h.sync(client);
    client.deleteTask = realDelete;

    return { titles: await h.titles(), ok: res.ok,
             tombs: await h.db.tombstones.count(), remote: client.taskCount };
  `);
  R.ok('the delete is still pending', r.tombs === 1, `tombstones=${r.tombs}`);
  R.ok('the server copy still exists', r.remote === 1, `remote=${r.remote}`);
  R.ok('the task did NOT come back', r.titles.length === 0, JSON.stringify(r.titles));
}

R.section('2. Retrying after the outage clears the server copy');
{
  const r = await run(`
    const client = new h.FakeGraphClient();
    await h.reset();
    const id = await h.db.tasks.add(h.T({title:'Ghost'}));
    await h.sync(client);
    await h.uiDeleteTask(id);

    const realDelete = client.deleteTask.bind(client);
    client.deleteTask = async () => { throw new Error('network unreachable'); };
    await h.sync(client);
    client.deleteTask = realDelete;

    const res = await h.sync(client);
    return { titles: await h.titles(), remote: client.taskCount,
             tombs: await h.db.tombstones.count(), ok: res.ok };
  `);
  R.ok('sync recovers', r.ok === true);
  R.ok('server copy finally deleted', r.remote === 0, `remote=${r.remote}`);
  R.ok('tombstone retired', r.tombs === 0, `tombstones=${r.tombs}`);
  R.ok('still no resurrection', r.titles.length === 0, JSON.stringify(r.titles));
}

R.section('3. A task deleted on another device is not re-pushed');
{
  const r = await run(`
    await h.reset();
    const client = new h.FakeGraphClient();
    const id = await h.db.tasks.add(h.T({title:'Shared'}));
    await h.sync(client);
    // The other device deleted it and our pull learned that.
    await h.uiDeleteTask(id);
    await h.sync(client);
    return { titles: await h.titles(), remote: client.taskCount };
  `);
  R.ok('gone locally', r.titles.length === 0, JSON.stringify(r.titles));
  R.ok('gone remotely', r.remote === 0, `remote=${r.remote}`);
}

R.section('4. A genuinely new remote task is still pulled in');
{
  const r = await run(`
    await h.reset();
    const client = new h.FakeGraphClient();
    await h.sync(client);
    const list = client.findListByName('Tasks');
    await client.createTask(list.id, { title: 'From phone' });
    const res = await h.sync(client);
    return { titles: await h.titles(), ok: res.ok, created: res.pulled.created };
  `);
  R.ok('sync ok', r.ok === true);
  R.ok('new remote task arrives', r.titles.includes('From phone'), JSON.stringify(r.titles));
}

R.section('5. A new device does not merge its demo board into a real one');
{
  const r = await run(`
    await h.newDevice();
    h.file.text = null; h.file.sha = '';
    // Device one: a real board, saved to the shared file.
    await h.db.tasks.add(h.T({title:'Real work'}));
    await h.runBackup();

    // Device two: a fresh database, so the seed has just run. The uids are the
    // stable ones the seed writes, which is what marks them as examples.
    await h.newDevice();
    await h.db.projects.add(h.P({name:'Hiring', uid:'example:project:hiring'}));
    await h.db.tasks.add(h.T({title:'Review PR #482', uid:'example:task:review-pr-482'}));
    await h.runBackup();

    return { titles: await h.titles(), names: await h.projectNames(),
             file: JSON.parse(h.file.text).tasks.map(t => t.title).sort() };
  `);
  R.ok('the examples are dropped locally', !r.titles.includes('Review PR #482'), JSON.stringify(r.titles));
  R.ok('the example project is dropped too', r.names.length === 0, JSON.stringify(r.names));
  R.ok('the real board arrives instead', JSON.stringify(r.titles) === '["Real work"]', JSON.stringify(r.titles));
  R.ok('the shared file is left clean', JSON.stringify(r.file) === '["Real work"]', JSON.stringify(r.file));
}

R.section('6. A board with real work on it keeps its examples');
{
  const r = await run(`
    await h.newDevice();
    h.file.text = null; h.file.sha = '';
    await h.db.tasks.add(h.T({title:'Real work'}));
    await h.runBackup();

    // The user kept an example and added something of their own next to it.
    // That makes it their board, and none of it is ours to throw away.
    await h.newDevice();
    await h.db.tasks.add(h.T({title:'Review PR #482', uid:'example:task:review-pr-482'}));
    await h.db.tasks.add(h.T({title:'Mine'}));
    await h.runBackup();

    return { titles: await h.titles() };
  `);
  R.ok('the kept example survives', r.titles.includes('Review PR #482'), JSON.stringify(r.titles));
  R.ok('so does the real task', r.titles.includes('Mine'), JSON.stringify(r.titles));
}

R.section('7. Deleting every project does not re-seed the demo board');
{
  await run(`
    await h.reset();
    const pid = await h.db.projects.add(h.P({name:'Only project'}));
    await h.db.tasks.add(h.T({title:'Mine', projectId:pid}));
    await h.uiDeleteProject(pid);
  `);
  // The seed runs once per page load, so the reload is the point of the test.
  await send('Page.reload', {});
  await new Promise((r) => setTimeout(r, 4000));
  const r = await js(`(async () => {
    const db = window.__fb.db;
    return { projects: (await db.projects.toArray()).map(p=>p.name).sort(),
             titles: (await db.tasks.toArray()).map(t=>t.title).sort() };
  })()`);
  R.ok('deleted project stays deleted', !r.projects.includes('Only project'), JSON.stringify(r.projects));
  R.ok('no demo projects appear', r.projects.length === 0, JSON.stringify(r.projects));
  R.ok('no demo tasks appear', JSON.stringify(r.titles) === '["Mine"]', JSON.stringify(r.titles));
}

R.section('8. A genuinely new database still gets its examples');
{
  // Deleting the database, rather than clearing its tables, is the point: the
  // seed is meant to fire on first run, and only a fresh database is that.
  await js(`(async () => {
    window.__fb.db.close();
    await new Promise((res, rej) => {
      const req = indexedDB.deleteDatabase('ProductivityDB');
      req.onsuccess = res; req.onerror = rej; req.onblocked = res;
    });
    return true;
  })()`);
  await send('Page.reload', {});
  await new Promise((r) => setTimeout(r, 4000));
  const seeded = await js(`(async () => {
    const db = window.__fb.db;
    return { projects: await db.projects.count(), tasks: await db.tasks.count() };
  })()`);
  R.ok('example projects seeded', seeded.projects > 0, JSON.stringify(seeded));
  R.ok('example tasks seeded', seeded.tasks > 0, JSON.stringify(seeded));
}

const good = R.done(errors);
close();
process.exit(good ? 0 : 1);
