import { connect, reporter } from './lib.mjs';
const { js, errors, close } = await connect();

const R = reporter();

// The reason link state moved out of the records and into `syncLinks`: one task
// has to hold an independent id, change marker and sync clock per provider.
await js(`window.__d = (() => {
  const { db, runSync, recordTombstone, FakeGraphClient, FakeGoogleClient,
          msProvider, googleProvider, links } = window.__fb;
  const now = () => Date.now();
  // Google only carries the personal half, so the shared fixtures are personal;
  // sections that care about the work/personal split set it explicitly.
  const T = (p={}) => ({ title:'t', notes:'', domain:'personal', priority:2, estimateMin:30,
    focusLevel:'medium', status:'todo', tags:[], createdAt:now(), updatedAt:now(), ...p });
  const P = (p={}) => ({ name:'P', domain:'personal', color:'#6366f1', archived:0,
    createdAt:now(), updatedAt:now(), ...p });
  return {
    T, P, db, recordTombstone,
    async fresh() {
      await db.tasks.clear(); await db.projects.clear();
      await db.tombstones.clear(); await db.syncState.clear();
      await db.syncLinks.clear();
      window.__ms = new FakeGraphClient();
      window.__gt = new FakeGoogleClient();
      return true;
    },
    ms: () => window.__ms,        gt: () => window.__gt,
    // Strictly-later timestamps: hasLocalEdits is \`updatedAt > syncedAt\`.
    async settle() { await new Promise(r => setTimeout(r, 3)); },
    async edit(id, patch) {
      await this.settle();
      await db.tasks.update(id, { ...patch, updatedAt: Date.now() });
    },
    syncMs() { return runSync(msProvider(window.__ms)); },
    syncGt() { return runSync(googleProvider(window.__gt)); },
    async both() { return [await this.syncMs(), await this.syncGt()]; },
    async link(provider, kind, localId) { return links.getLink(provider, kind, localId); },
    async tasks() { return db.tasks.toArray(); },
    async byTitle(t) { return (await db.tasks.toArray()).find(x => x.title === t); },
  };
})(); 'ready'`);

const run = async (body) => js(`(async () => { const h = window.__d; ${body} })()`);

R.section('1. One task mirrors to both services independently');
{
  const r = await run(`
    await h.fresh();
    const pid = await h.db.projects.add(h.P({name:'Hiring'}));
    const id = await h.db.tasks.add(h.T({title:'Screen resumes', projectId:pid, priority:1,
      estimateMin:45, focusLevel:'deep', tags:['hr'], dueDate:'2026-04-01'}));
    await h.both();
    const msLink = await h.link('mstodo','task',id);
    const gtLink = await h.link('gtasks','task',id);
    return {
      msLink, gtLink,
      msRemote: h.ms().findTaskByTitle('Screen resumes'),
      gtRemote: h.gt().findTaskByTitle('Screen resumes'),
      msLists: h.ms().listNames(), gtLists: h.gt().listNames(),
      localCount: (await h.tasks()).length,
      linkCount: await h.db.syncLinks.count(),
    };
  `);
  R.ok('present in Microsoft', !!r.msRemote, 'missing');
  R.ok('present in Google', !!r.gtRemote, 'missing');
  R.ok('still exactly one local task', r.localCount === 1, String(r.localCount));
  R.ok('two task links, one per provider', r.msLink.provider === 'mstodo' && r.gtLink.provider === 'gtasks',
    JSON.stringify([r.msLink?.provider, r.gtLink?.provider]));
  R.ok('remote ids are independent', r.msLink.remoteId !== r.gtLink.remoteId,
    `${r.msLink.remoteId} vs ${r.gtLink.remoteId}`);
  R.ok('four links total (task + project, twice)', r.linkCount === 4, String(r.linkCount));
  R.ok('project list created in Microsoft', r.msLists.includes('Hiring'), r.msLists.join(','));
  R.ok('project list created in Google', r.gtLists.includes('Hiring'), r.gtLists.join(','));
  R.ok('Microsoft uses its native priority field', r.msRemote.importance === 'high', r.msRemote.importance);
  R.ok('Microsoft uses its native categories', JSON.stringify(r.msRemote.categories) === '["hr"]', JSON.stringify(r.msRemote.categories));
  R.ok('Google falls back to the notes footer for tags', /tags=hr/.test(r.gtRemote.notes), r.gtRemote.notes);
  R.ok('Microsoft footer omits tags it can store natively', !/tags=/.test(r.msRemote.body.content), r.msRemote.body.content);
}

R.section('2. Re-syncing both is a no-op on both');
{
  const r = await run(`
    h.ms().resetCallCounts(); h.gt().resetCallCounts();
    const [ms, gt] = await h.both();
    return { ms, gt, msCalls: h.ms().calls, gtCalls: h.gt().calls,
      msCount: h.ms().taskCount, gtCount: h.gt().taskCount, local: (await h.tasks()).length };
  `);
  R.ok('no Microsoft writes', r.msCalls.createTask === 0 && r.msCalls.updateTask === 0, JSON.stringify(r.msCalls));
  R.ok('no Google writes', r.gtCalls.createTask === 0 && r.gtCalls.updateTask === 0, JSON.stringify(r.gtCalls));
  R.ok('no local duplicates', r.local === 1, String(r.local));
  R.ok('one copy in each service', r.msCount === 1 && r.gtCount === 1, `${r.msCount}/${r.gtCount}`);
}

R.section('3. A local edit reaches both services');
{
  const r = await run(`
    const t = await h.byTitle('Screen resumes');
    await h.edit(t.id, { title:'Screen 6 resumes', estimateMin:60 });
    await h.both();
    return { ms: h.ms().findTaskByTitle('Screen 6 resumes'), gt: h.gt().findTaskByTitle('Screen 6 resumes'),
      msCount: h.ms().taskCount, gtCount: h.gt().taskCount };
  `);
  R.ok('Microsoft updated', !!r.ms, 'missing');
  R.ok('Google updated', !!r.gt, 'missing');
  R.ok('Microsoft footer carries new estimate', /est=60m/.test(r.ms.body.content), r.ms.body.content);
  R.ok('Google footer carries new estimate', /est=60m/.test(r.gt.notes), r.gt.notes);
  R.ok('no duplicates anywhere', r.msCount === 1 && r.gtCount === 1, `${r.msCount}/${r.gtCount}`);
}

R.section('4. An edit made in Google propagates through to Microsoft');
{
  const r = await run(`
    const t = await h.byTitle('Screen 6 resumes');
    const gid = (await h.link('gtasks','task',t.id)).remoteId;
    h.gt().advanceClock(60000);
    h.gt().editTaskRemotely(gid, { title:'Edited on the phone' });
    const gt = await h.syncGt();
    const local = await h.db.tasks.get(t.id);
    const ms = await h.syncMs();
    return { gt, ms, local, msRemote: h.ms().findTaskByTitle('Edited on the phone'),
      msCount: h.ms().taskCount, localCount: (await h.tasks()).length };
  `);
  R.ok('pulled into the local board', r.local.title === 'Edited on the phone', r.local.title);
  R.ok('Google run counted one pull', r.gt.pulled.updated === 1, JSON.stringify(r.gt.pulled));
  R.ok('Microsoft run pushed it onward', r.ms.pushed.updated === 1, JSON.stringify(r.ms.pushed));
  R.ok('Microsoft copy now matches', !!r.msRemote, 'missing');
  R.ok('no duplicate created in Microsoft', r.msCount === 1, String(r.msCount));
  R.ok('no duplicate created locally', r.localCount === 1, String(r.localCount));
}

R.section('5. A task created in Microsoft reaches Google once it is filed as personal');
{
  const r = await run(`
    const inbox = h.ms().findListByName('Tasks').id;
    h.ms().seedTask(inbox, { title:'Added in To Do', importance:'high', categories:['errand'] });
    await h.syncMs();
    const local = await h.byTitle('Added in To Do');
    await h.syncGt();
    // Arrived as work, so Google must not have it yet.
    const whileWork = { gt: h.gt().findTaskByTitle('Added in To Do'), count: h.gt().taskCount };
    await h.edit(local.id, { domain:'personal' });
    await h.syncGt();
    return { local, whileWork, gt: h.gt().findTaskByTitle('Added in To Do'),
      gtCount: h.gt().taskCount, localCount: (await h.tasks()).length };
  `);
  R.ok('imported locally', !!r.local, 'missing');
  R.ok('filed as work by default', r.local.domain === 'work', r.local.domain);
  R.ok('priority read from Microsoft importance', r.local.priority === 2, String(r.local.priority));
  R.ok('withheld from Google while it is work', !r.whileWork.gt, 'leaked');
  R.ok('Google untouched meanwhile', r.whileWork.count === 1, String(r.whileWork.count));
  R.ok('reached Google', !!r.gt, 'missing');
  R.ok('priority preserved in the Google footer', /prio=P2/.test(r.gt.notes), r.gt.notes);
  R.ok('tags preserved in the Google footer', /tags=errand/.test(r.gt.notes), r.gt.notes);
  R.ok('two tasks in Google now', r.gtCount === 2, String(r.gtCount));
  R.ok('two tasks locally', r.localCount === 2, String(r.localCount));
}

R.section('6. Deleting locally removes it from both services');
{
  const r = await run(`
    const t = await h.byTitle('Added in To Do');
    await h.recordTombstone('task', t.id);
    await h.db.tasks.delete(t.id);
    const tombs = await h.db.tombstones.toArray();
    const [ms, gt] = await h.both();
    return { providers: tombs.map(x=>x.provider).sort(), ms, gt,
      msLeft: h.ms().taskCount, gtLeft: h.gt().taskCount,
      remaining: (await h.db.tombstones.count()),
      links: await h.db.syncLinks.where('localId').equals(t.id).count() };
  `);
  R.ok('one tombstone per provider', JSON.stringify(r.providers) === '["gtasks","mstodo"]', JSON.stringify(r.providers));
  R.ok('links dropped immediately', r.links === 0, String(r.links));
  R.ok('removed from Microsoft', r.msLeft === 1, String(r.msLeft));
  R.ok('removed from Google', r.gtLeft === 1, String(r.gtLeft));
  R.ok('both tombstones consumed', r.remaining === 0, String(r.remaining));
}

R.section('7. Deleting in Google also removes it from Microsoft');
{
  const r = await run(`
    const t = await h.byTitle('Edited on the phone');
    const gLink = await h.link('gtasks','task',t.id);
    await h.gt().deleteTask(gLink.remoteListId, gLink.remoteId);
    const gt = await h.syncGt();
    const afterPull = { local: (await h.tasks()).length,
      tombs: (await h.db.tombstones.toArray()).map(x=>x.provider) };
    const ms = await h.syncMs();
    return { gt, ms, afterPull, msLeft: h.ms().taskCount,
      remaining: await h.db.tombstones.count() };
  `);
  R.ok('gone locally', r.afterPull.local === 0, String(r.afterPull.local));
  R.ok('only Microsoft is left a tombstone', JSON.stringify(r.afterPull.tombs) === '["mstodo"]', JSON.stringify(r.afterPull.tombs));
  R.ok('Microsoft copy deleted on its next run', r.msLeft === 0, String(r.msLeft));
  R.ok('tombstone consumed', r.remaining === 0, String(r.remaining));
}

R.section('8. Resetting one provider leaves the other intact');
{
  const r = await run(`
    await h.fresh();
    await h.db.tasks.add(h.T({title:'Shared task'}));
    await h.both();
    const before = { ms: await h.db.syncLinks.where('provider').equals('mstodo').count(),
                     gt: await h.db.syncLinks.where('provider').equals('gtasks').count() };
    const { resetSyncState } = window.__fb;
    await resetSyncState('gtasks');
    const after = { ms: await h.db.syncLinks.where('provider').equals('mstodo').count(),
                    gt: await h.db.syncLinks.where('provider').equals('gtasks').count() };
    // Re-syncing Google must re-adopt what is already there, not duplicate it.
    h.ms().resetCallCounts(); h.gt().resetCallCounts();
    await h.syncGt();
    return { before, after, gtCount: h.gt().taskCount, gtLists: h.gt().listNames(),
      gtCalls: h.gt().calls, local: (await h.tasks()).length,
      msLinks: await h.db.syncLinks.where('provider').equals('mstodo').count() };
  `);
  R.ok('both were linked to begin with', r.before.ms > 0 && r.before.gt > 0, JSON.stringify(r.before));
  R.ok('Google links cleared', r.after.gt === 0, String(r.after.gt));
  R.ok('Microsoft links untouched by the reset', r.after.ms === r.before.ms, JSON.stringify(r.after));
  R.ok('Microsoft links still intact after re-sync', r.msLinks === r.before.ms, String(r.msLinks));
  R.ok('no duplicate task in Google', r.gtCount === 1, String(r.gtCount));
  R.ok('no duplicate list in Google', r.gtLists.length === 1, JSON.stringify(r.gtLists));
  R.ok('re-adopted rather than re-created', r.gtCalls.createTask === 0, JSON.stringify(r.gtCalls));
  R.ok('local board unchanged', r.local === 1, String(r.local));
}

R.section('9. Disconnecting one service does not orphan the other');
{
  const r = await run(`
    await h.fresh();
    const id = await h.db.tasks.add(h.T({title:'Solo'}));
    await h.both();
    const { resetSyncState } = window.__fb;
    await resetSyncState('mstodo');
    // Google keeps working on its own from here.
    await h.edit(id, { title:'Solo edited' });
    const gt = await h.syncGt();
    return { gt, gtRemote: h.gt().findTaskByTitle('Solo edited'),
      gtCount: h.gt().taskCount, msLinks: await h.db.syncLinks.where('provider').equals('mstodo').count() };
  `);
  R.ok('Microsoft links gone', r.msLinks === 0, String(r.msLinks));
  R.ok('Google sync still succeeds', r.gt.ok === true, JSON.stringify(r.gt.errors));
  R.ok('Google received the edit', !!r.gtRemote, 'missing');
  R.ok('no duplicate in Google', r.gtCount === 1, String(r.gtCount));
}

R.section('10. Each service files unfamiliar records into its own area');
{
  const r = await run(`
    await h.fresh();
    // Nothing local: every record below is authored on the far side.
    h.ms().seedTask(h.ms().seedList('Q3 planning'), { title:'Draft roadmap' });
    h.gt().seedTask(h.gt().seedList('Groceries'), { title:'Buy oat milk' });
    await h.both();
    const all = await h.tasks();
    const projects = await h.db.projects.toArray();
    const find = (n) => projects.find(p => p.name === n);
    return {
      msTask: all.find(t => t.title === 'Draft roadmap'),
      gtTask: all.find(t => t.title === 'Buy oat milk'),
      msProject: find('Q3 planning'), gtProject: find('Groceries'),
    };
  `);
  R.ok('task from Microsoft is work', r.msTask?.domain === 'work', r.msTask?.domain);
  R.ok('task from Google is personal', r.gtTask?.domain === 'personal', r.gtTask?.domain);
  R.ok('list from Microsoft becomes a work project', r.msProject?.domain === 'work', r.msProject?.domain);
  R.ok('list from Google becomes a personal project', r.gtProject?.domain === 'personal', r.gtProject?.domain);
}

R.section('11. The project a task lands in still outranks the service default');
{
  // Microsoft is the one that carries both halves, so it's where a project
  // domain can actually disagree with the service default.
  const r = await run(`
    await h.fresh();
    const pid = await h.db.projects.add(h.P({name:'Health', domain:'personal'}));
    await h.syncMs();
    const listId = h.ms().findListByName('Health').id;
    h.ms().seedTask(listId, { title:'Book physio' });
    // And an inbox task, which belongs to no project at all.
    h.ms().seedTask(h.ms().findListByName('Tasks').id, { title:'File expenses' });
    await h.syncMs();
    const all = await h.tasks();
    return {
      inProject: all.find(t => t.title === 'Book physio'),
      inInbox: all.find(t => t.title === 'File expenses'),
    };
  `);
  R.ok('Microsoft task in a personal project is personal', r.inProject?.domain === 'personal', r.inProject?.domain);
  R.ok('project-less Microsoft task falls back to work', r.inInbox?.domain === 'work', r.inInbox?.domain);
}

R.section('12. An area written by this app survives the round trip');
{
  const r = await run(`
    await h.fresh();
    // Authored here as personal, pushed to Microsoft, then pulled back cold.
    // Microsoft would default it to work if the footer were not read.
    const id = await h.db.tasks.add(h.T({title:'Expense report', domain:'personal'}));
    await h.syncMs();
    const remote = h.ms().findTaskByTitle('Expense report');
    await h.db.tasks.clear();
    await h.db.syncLinks.clear();
    await h.db.syncState.clear();
    await h.syncMs();
    const back = await h.byTitle('Expense report');
    return { notes: remote.body.content, domain: back?.domain };
  `);
  R.ok('footer records the area', /area=personal/.test(r.notes), r.notes);
  R.ok('footer beats the Microsoft default', r.domain === 'personal', r.domain);
}

R.section('13. Work stays in Microsoft; personal goes to both');
{
  const r = await run(`
    await h.fresh();
    const wp = await h.db.projects.add(h.P({name:'Platform', domain:'work'}));
    const pp = await h.db.projects.add(h.P({name:'Health', domain:'personal'}));
    await h.db.tasks.add(h.T({title:'Ship migration', projectId:wp, domain:'work'}));
    await h.db.tasks.add(h.T({title:'Book dentist', projectId:pp, domain:'personal'}));
    await h.db.tasks.add(h.T({title:'Work errand', domain:'work'}));
    await h.db.tasks.add(h.T({title:'Personal errand', domain:'personal'}));
    const [ms, gt] = await h.both();
    return { ms, gt,
      msLists: h.ms().listNames(), gtLists: h.gt().listNames(),
      msCount: h.ms().taskCount, gtCount: h.gt().taskCount,
      gtHasWorkTask: !!h.gt().findTaskByTitle('Ship migration'),
      gtHasWorkErrand: !!h.gt().findTaskByTitle('Work errand'),
      msHasPersonal: !!h.ms().findTaskByTitle('Book dentist'),
      gtHasPersonal: !!h.gt().findTaskByTitle('Book dentist'),
      localCount: (await h.tasks()).length,
    };
  `);
  R.ok('both syncs clean', r.ms.ok && r.gt.ok, JSON.stringify([r.ms.errors, r.gt.errors]));
  R.ok('Microsoft has every task', r.msCount === 4, String(r.msCount));
  R.ok('Google has only the personal two', r.gtCount === 2, String(r.gtCount));
  R.ok('work project not published to Google', !r.gtLists.includes('Platform'), r.gtLists.join(','));
  R.ok('personal project is', r.gtLists.includes('Health'), r.gtLists.join(','));
  R.ok('Microsoft got both projects', r.msLists.includes('Platform') && r.msLists.includes('Health'), r.msLists.join(','));
  R.ok('no work task in Google', !r.gtHasWorkTask && !r.gtHasWorkErrand, 'work leaked to Google');
  R.ok('personal task in Microsoft', r.msHasPersonal, 'missing');
  R.ok('personal task in Google', r.gtHasPersonal, 'missing');
  R.ok('nothing duplicated locally', r.localCount === 4, String(r.localCount));
}

R.section('14. Re-filing a task moves it between services');
{
  const r = await run(`
    await h.fresh();
    const id = await h.db.tasks.add(h.T({title:'Taxes', domain:'personal'}));
    await h.both();
    const before = { ms: !!h.ms().findTaskByTitle('Taxes'), gt: !!h.gt().findTaskByTitle('Taxes'),
                     gtLink: !!(await h.link('gtasks','task',id)) };
    await h.edit(id, { domain:'work' });
    const [ms, gt] = await h.both();
    const after = { ms: !!h.ms().findTaskByTitle('Taxes'), gt: !!h.gt().findTaskByTitle('Taxes'),
                    gtLink: !!(await h.link('gtasks','task',id)) };
    // A third run must not resurrect it.
    await h.both();
    return { before, after, ms, gt, gtCount: h.gt().taskCount,
      stillLocal: !!(await h.byTitle('Taxes')), localCount: (await h.tasks()).length };
  `);
  R.ok('personal task started in both', r.before.ms && r.before.gt, JSON.stringify(r.before));
  R.ok('withdrawn from Google once it became work', !r.after.gt, 'still there');
  R.ok('Google link dropped', !r.after.gtLink, 'link kept');
  R.ok('still in Microsoft', r.after.ms, 'missing');
  R.ok('withdrawal counted as a push delete', r.gt.pushed.deleted === 1, JSON.stringify(r.gt.pushed));
  R.ok('sync still clean', r.ms.ok && r.gt.ok, JSON.stringify([r.ms.errors, r.gt.errors]));
  R.ok('never comes back on later runs', r.gtCount === 0, String(r.gtCount));
  R.ok('local task untouched', r.stillLocal && r.localCount === 1, String(r.localCount));
}

R.section('15. Re-filing a project withdraws its list from Google');
{
  const r = await run(`
    await h.fresh();
    const pid = await h.db.projects.add(h.P({name:'Side hustle', domain:'personal'}));
    const tid = await h.db.tasks.add(h.T({title:'Invoice client', projectId:pid, domain:'personal'}));
    await h.both();
    const before = h.gt().listNames();
    await h.db.projects.update(pid, { domain:'work', updatedAt: Date.now() });
    await h.edit(tid, { domain:'work' });
    const [ms, gt] = await h.both();
    return { before, ms, gt,
      after: h.gt().listNames(), msLists: h.ms().listNames(),
      gtCount: h.gt().taskCount, msHas: !!h.ms().findTaskByTitle('Invoice client'),
      taskLinks: await h.db.syncLinks.where('provider').equals('gtasks').count(),
      localTasks: (await h.tasks()).length,
      localProjects: (await h.db.projects.toArray()).length };
  `);
  R.ok('list existed in Google first', r.before.includes('Side hustle'), r.before.join(','));
  R.ok('list withdrawn from Google', !r.after.includes('Side hustle'), r.after.join(','));
  R.ok('its task went with it', r.gtCount === 0, String(r.gtCount));
  R.ok('no orphan Google links', r.taskLinks === 0, String(r.taskLinks));
  R.ok('Microsoft keeps the list', r.msLists.includes('Side hustle'), r.msLists.join(','));
  R.ok('Microsoft keeps the task', r.msHas, 'missing');
  R.ok('sync clean', r.ms.ok && r.gt.ok, JSON.stringify([r.ms.errors, r.gt.errors]));
  R.ok('nothing deleted locally', r.localTasks === 1 && r.localProjects === 1,
    `${r.localTasks}/${r.localProjects}`);
}

R.section('16. A personal task inside a work project falls back to the Google inbox');
{
  const r = await run(`
    await h.fresh();
    const pid = await h.db.projects.add(h.P({name:'Migration', domain:'work'}));
    await h.db.tasks.add(h.T({title:'Call the accountant', projectId:pid, domain:'personal'}));
    const [ms, gt] = await h.both();
    const inbox = await h.gt().defaultListId();
    return { ms, gt, gtLists: h.gt().listNames(),
      inboxTitles: h.gt().tasksInList(inbox).map(t=>t.title) };
  `);
  R.ok('sync clean', r.ms.ok && r.gt.ok, JSON.stringify([r.ms.errors, r.gt.errors]));
  R.ok('no work list created in Google', !r.gtLists.includes('Migration'), r.gtLists.join(','));
  R.ok('task landed in the Google inbox', r.inboxTitles.includes('Call the accountant'),
    JSON.stringify(r.inboxTitles));
}

const passed = R.done(errors);
close();
process.exit(passed ? 0 : 1);
