// The JSON board file: one document in a Git repository, shared by every device.
//
// The risk here is not reading or writing a file, it is everything two devices
// can do to the same record between two syncs. So most of this suite is about
// disagreement: the same task edited twice, a deletion racing an edit, and two
// writes landing on the same blob. Those are the cases that quietly lose work,
// and none of them are visible from a single browser without forcing them.
import { connect, reporter } from './lib.mjs';

const t = await connect();
const r = reporter();
const js = t.js;
const eq = (n, a, e) =>
  r.ok(n, JSON.stringify(a) === JSON.stringify(e), `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);

const install = () => js(`(async () => { window.__k = await (async () => {
  const B = window.__fb.backup;
  const { db } = window.__fb;
  const now = () => Date.now();
  const file = new B.FakeGitHubFile();

  return {
    B, db, file,
    async reset() {
      await db.tasks.clear();
      await db.projects.clear();
      await db.graveyard.clear();
      await db.tombstones.clear();
      await db.syncLinks.clear();
      file.text = null;
      file.sha = '';
      file.calls = { read: 0, write: 0, rejected: 0 };
      file.interpose = null;
    },
    /** Adds a task the way the app would, and hands back the stored row. */
    async task(title, patch = {}) {
      const id = await db.tasks.add({
        uid: crypto.randomUUID(), title, notes: '', domain: 'work', priority: 2,
        estimateMin: 30, focusLevel: 'medium', status: 'todo', tags: [],
        createdAt: now(), updatedAt: now(), ...patch,
      });
      return db.tasks.get(id);
    },
    async project(name, patch = {}) {
      const id = await db.projects.add({
        uid: crypto.randomUUID(), name, domain: 'work', color: '#888',
        archived: 0, createdAt: now(), updatedAt: now(), ...patch,
      });
      return db.projects.get(id);
    },
    async byTitle(title) { return (await db.tasks.toArray()).find(x => x.title === title); },
    async titles() { return (await db.tasks.toArray()).map(x => x.title).sort(); },
    /** The file as a parsed document, or null when it does not exist yet. */
    doc() { return file.text === null ? null : JSON.parse(file.text); },
    /** Rewrites the file, standing in for a second device that has synced. */
    put(doc) { file.set(JSON.stringify(doc, null, 2)); },
    run(now) { return B.runBackup(file, now); },
  };
})(); return 'ready'; })()`);

await install();
const run = (body) => js(`(async () => { const f = window.__k; ${body} })()`);

// ---------------------------------------------------------------------------

r.section('1. Every record carries a portable identity');
await run(`await f.reset();`);
const ids = await run(`
  const p = await f.project('Platform');
  const a = await f.task('parent', { projectId: p.id });
  const b = await f.task('child', { projectId: p.id, blockedBy: a.id });
  const snap = await f.B.readLocal(Date.now());
  const child = snap.tasks.find(x => x.title === 'child');
  return {
    uids: snap.tasks.every(x => typeof x.uid === 'string' && x.uid.length > 0),
    noLocalIds: snap.tasks.every(x => !('id' in x)) && snap.projects.every(x => !('id' in x)),
    projectByUid: child.projectUid === p.uid,
    blockerByUid: child.blockedByUid === a.uid,
    noNumericRefs: !('projectId' in child) && !('blockedBy' in child),
    app: snap.app,
  };
`);
eq('every task has a uid', ids.uids, true);
eq('device-local ids are left out', ids.noLocalIds, true);
eq('a project reference travels as a uid', ids.projectByUid, true);
eq('so does a blocker', ids.blockerByUid, true);
eq('and the numeric forms are gone', ids.noNumericRefs, true);
eq('the document names the app that wrote it', ids.app, 'nextwise');

r.section('2. The first sync creates the file');
const first = await run(`
  const before = f.doc();
  const res = await f.run(Date.now());
  const doc = f.doc();
  return { before, pushed: res.pushed, tasks: doc.tasks.length, reads: f.file.calls.read, writes: f.file.calls.write };
`);
eq('there is no file to begin with', first.before, null);
eq('the first run writes one', first.pushed, true);
eq('with the whole board in it', first.tasks, 2);
eq('after reading it once', first.reads, 1);
eq('and writing it once', first.writes, 1);

r.section('3. An unchanged board is not rewritten');
const idle = await run(`
  const res = await f.run(Date.now());
  return { pushed: res.pushed, writes: f.file.calls.write, pulled: res.pulled };
`);
eq('nothing is pushed', idle.pushed, false);
eq('and no commit is made', idle.writes, 1);
eq('nor is anything pulled', idle.pulled, { created: 0, updated: 0, deleted: 0 });

r.section('4. A second device picks the board up');
await run(`await f.reset();`);
const adopt = await run(`
  const p = await f.project('Platform');
  const a = await f.task('parent', { projectId: p.id });
  await f.task('child', { projectId: p.id, blockedBy: a.id });
  await f.run(Date.now());
  const doc = f.doc();
  // Wipe the device entirely, as a fresh browser would be, then sync.
  await f.db.tasks.clear(); await f.db.projects.clear(); await f.db.graveyard.clear();
  f.put(doc);
  const res = await f.run(Date.now());
  const child = await f.byTitle('child');
  const parent = await f.byTitle('parent');
  const project = (await f.db.projects.toArray())[0];
  return {
    created: res.pulled.created,
    titles: await f.titles(),
    projectResolved: child.projectId === project.id,
    blockerResolved: child.blockedBy === parent.id,
    uidKept: child.uid === doc.tasks.find(x => x.title === 'child').uid,
  };
`);
eq('every record arrives', adopt.titles, ['child', 'parent']);
eq('counted as created', adopt.created, 3);
eq('the project reference resolves to a local id', adopt.projectResolved, true);
eq('so does the blocker', adopt.blockerResolved, true);
eq('and the identity is preserved, not reissued', adopt.uidKept, true);

r.section('5. Two devices editing different tasks both win');
await run(`await f.reset();`);
const both = await run(`
  await f.task('mine');
  await f.task('theirs');
  await f.run(Date.now());
  const doc = f.doc();
  // The other device renames one task and this one renames the other.
  const theirs = doc.tasks.find(x => x.title === 'theirs');
  theirs.title = 'theirs renamed';
  theirs.updatedAt = Date.now() + 1000;
  f.put(doc);
  const local = await f.byTitle('mine');
  await f.db.tasks.update(local.id, { title: 'mine renamed', updatedAt: Date.now() + 1000 });
  const res = await f.run(Date.now() + 2000);
  return { titles: await f.titles(), doc: f.doc().tasks.map(x => x.title).sort(), pushed: res.pushed };
`);
eq('both edits survive locally', both.titles, ['mine renamed', 'theirs renamed']);
eq('and both reach the file', both.doc, ['mine renamed', 'theirs renamed']);
eq('which had to be rewritten', both.pushed, true);

r.section('6. The same task edited twice keeps the later edit');
await run(`await f.reset();`);
const clash = await run(`
  await f.task('contested');
  await f.run(1000);
  const doc = f.doc();
  doc.tasks[0].title = 'their version';
  doc.tasks[0].updatedAt = 5000;
  f.put(doc);
  const local = await f.byTitle('contested');
  await f.db.tasks.update(local.id, { title: 'my older version', updatedAt: 3000 });
  await f.run(6000);
  return { titles: await f.titles(), count: (await f.db.tasks.toArray()).length };
`);
eq('the newer edit wins', clash.titles, ['their version']);
eq('and it is one task, not two', clash.count, 1);

r.section('7. The older edit loses without being duplicated');
await run(`await f.reset();`);
const mineWins = await run(`
  await f.task('contested');
  await f.run(1000);
  const doc = f.doc();
  doc.tasks[0].title = 'their older version';
  doc.tasks[0].updatedAt = 2000;
  f.put(doc);
  const local = await f.byTitle('contested');
  await f.db.tasks.update(local.id, { title: 'my newer version', updatedAt: 9000 });
  await f.run(10000);
  return { titles: await f.titles(), doc: f.doc().tasks.map(x => x.title) };
`);
eq('this device keeps its edit', mineWins.titles, ['my newer version']);
eq('and the file is corrected', mineWins.doc, ['my newer version']);

r.section('8. A deletion travels, instead of being undone');
await run(`await f.reset();`);
const gone = await run(`
  const keep = await f.task('keep');
  const drop = await f.task('drop');
  await f.run(1000);
  // Delete it the way the app does: record the grave, then remove the row.
  await f.B.recordGrave('task', drop.uid);
  await f.db.tasks.delete(drop.id);
  await f.run(2000);
  const doc = f.doc();
  return {
    titles: await f.titles(),
    inFile: doc.tasks.map(x => x.title),
    deletions: doc.deletions.map(d => d.kind),
    deletedUid: doc.deletions[0]?.uid === drop.uid,
  };
`);
eq('the task is gone here', gone.titles, ['keep']);
eq('and gone from the file', gone.inFile, ['keep']);
eq('with the deletion recorded', gone.deletions, ['task']);
eq('naming the record that went', gone.deletedUid, true);

r.section('9. A device that still holds the record lets it go');
const spread = await run(`
  const doc = f.doc();
  // This device never saw the deletion and still has the task.
  await f.db.graveyard.clear();
  await f.task('drop');
  const restored = await f.byTitle('drop');
  // Give it the uid the file remembers deleting, as the other device's copy would have.
  await f.db.tasks.update(restored.id, { uid: doc.deletions[0].uid, updatedAt: 500 });
  await f.run(3000);
  return { titles: await f.titles(), stillDeleted: f.doc().deletions.length };
`);
eq('the deletion is applied here too', spread.titles, ['keep']);
eq('and is still remembered', spread.stillDeleted, 1);

r.section('10. Editing a task after deleting it brings it back');
await run(`await f.reset();`);
const revive = await run(`
  const doomed = await f.task('doomed');
  await f.run(1000);
  await f.B.recordGrave('task', doomed.uid);
  await f.db.tasks.delete(doomed.id);
  await f.run(2000);
  const deletedAt = f.doc().deletions[0].deletedAt;
  // The other device edits it after the deletion was stamped.
  const doc = f.doc();
  doc.tasks.push({
    uid: doomed.uid, title: 'thought better of it', notes: '', domain: 'work',
    priority: 2, estimateMin: 30, focusLevel: 'medium', status: 'todo', tags: [],
    createdAt: 1, updatedAt: deletedAt + 1000,
  });
  f.put(doc);
  await f.run(4000);
  return { titles: await f.titles(), deletions: f.doc().deletions.length };
`);
eq('the later edit wins over the deletion', revive.titles, ['thought better of it']);
eq('and the deletion is dropped so they stop fighting', revive.deletions, 0);

r.section('11. Local-only detail survives the round trip');
await run(`await f.reset();`);
const local = await run(`
  const task = await f.task('detailed', {
    checklist: [{ id: 's1', text: 'step one', done: true }],
    spentMin: 42, notes: 'see https://example.com', blockedNote: 'waiting on Ana',
    dueDate: '2026-01-02', startDate: '2026-01-01', context: 'errand', tags: ['a', 'b'],
  });
  await f.run(1000);
  const doc = f.doc();
  await f.db.tasks.clear();
  f.put(doc);
  await f.run(2000);
  const back = await f.byTitle('detailed');
  return {
    checklist: back.checklist, spent: back.spentMin, note: back.blockedNote,
    due: back.dueDate, start: back.startDate, context: back.context, tags: back.tags,
    notes: back.notes,
  };
`);
eq('the checklist comes back intact', local.checklist, [{ id: 's1', text: 'step one', done: true }]);
eq('so does the time spent', local.spent, 42);
eq('and the waiting-on note', local.note, 'waiting on Ana');
eq('and both dates', [local.due, local.start], ['2026-01-02', '2026-01-01']);
eq('and the context', local.context, 'errand');
eq('and the tags', local.tags, ['a', 'b']);
eq('and the notes, links and all', local.notes, 'see https://example.com');

r.section('12. Pulling does not restamp what it wrote');
await run(`await f.reset();`);
const stamps = await run(`
  await f.task('stable', { updatedAt: 4242 });
  await f.run(1000);
  const doc = f.doc();
  await f.db.tasks.clear();
  f.put(doc);
  await f.run(9999);
  const back = await f.byTitle('stable');
  return { updatedAt: back.updatedAt, fileStamp: doc.tasks[0].updatedAt };
`);
eq('the file keeps the original clock', stamps.fileStamp, 4242);
eq('and so does the record it restores', stamps.updatedAt, 4242);

r.section('13. Losing a race is retried, not dropped');
await run(`await f.reset();`);
const race = await run(`
  await f.task('ours', { updatedAt: 1000 });
  await f.run(1000);
  const doc = f.doc();
  // Another device commits between this run's read and its write.
  f.file.interpose = () => {
    const theirs = JSON.parse(JSON.stringify(doc));
    theirs.tasks.push({
      uid: 'theirs-uid', title: 'slipped in first', notes: '', domain: 'work',
      priority: 2, estimateMin: 30, focusLevel: 'medium', status: 'todo', tags: [],
      createdAt: 1, updatedAt: 5000,
    });
    f.file.set(JSON.stringify(theirs));
  };
  const mine = await f.byTitle('ours');
  await f.db.tasks.update(mine.id, { title: 'ours edited', updatedAt: 6000 });
  const res = await f.run(7000);
  return {
    rejected: f.file.calls.rejected,
    pushed: res.pushed,
    titles: await f.titles(),
    inFile: f.doc().tasks.map(x => x.title).sort(),
  };
`);
eq('the first write is rejected', race.rejected, 1);
eq('the retry succeeds', race.pushed, true);
eq('and neither side is lost locally', race.titles, ['ours edited', 'slipped in first']);
eq('nor in the file', race.inFile, ['ours edited', 'slipped in first']);

r.section('14. A file that is not a board is refused');
const bad = await run(`
  const tries = [];
  for (const text of ['not json at all', '{"hello":"world"}', '{"app":"nextwise"}',
                      JSON.stringify({ app: 'nextwise', tasks: [{ title: 'no uid' }], projects: [] })]) {
    try { f.B.parseSnapshot(text); tries.push('accepted'); }
    catch (e) { tries.push(e.name); }
  }
  return tries;
`);
eq('every malformed shape is rejected', bad, [
  'SnapshotFormatError',
  'SnapshotFormatError',
  'SnapshotFormatError',
  'SnapshotFormatError',
]);

r.section('15. A board full of real text encodes cleanly');
const utf8 = await run(`
  const tricky = 'Café — "quoted" · 90% · emoji 🎯 · 日本語';
  const round = f.B.fromBase64(f.B.toBase64(tricky));
  await f.reset();
  await f.task(tricky, { notes: tricky });
  await f.run(1000);
  const doc = f.doc();
  await f.db.tasks.clear();
  f.put(doc);
  await f.run(2000);
  const back = (await f.db.tasks.toArray())[0];
  return { round, matches: round === tricky, title: back.title, notes: back.notes };
`);
eq('base64 survives non-ASCII text', utf8.matches, true);
eq('the title comes back exactly', utf8.title, 'Café — "quoted" · 90% · emoji 🎯 · 日本語');
eq('and so do the notes', utf8.notes, 'Café — "quoted" · 90% · emoji 🎯 · 日本語');

r.section('16. Deleting a project detaches rather than orphans');
await run(`await f.reset();`);
const orphan = await run(`
  const p = await f.project('Doomed', { updatedAt: 1000 });
  await f.task('survivor', { projectId: p.id, updatedAt: 1000 });
  await f.run(1000);
  // Another device deletes the project. This one hears about it through the
  // file, so nothing local has had the chance to detach the task first.
  const theirs = f.doc();
  theirs.projects = [];
  theirs.deletions = [{ kind: 'project', uid: p.uid, deletedAt: 2000 }];
  f.file.set(JSON.stringify(theirs));
  await f.run(3000);
  const doc = f.doc();
  const task = await f.byTitle('survivor');
  return {
    projects: doc.projects.length,
    localProjects: await f.db.projects.count(),
    taskKept: Boolean(task),
    detachedInFile: !('projectUid' in doc.tasks[0]),
    detachedLocally: task.projectId === undefined,
  };
`);
eq('the project leaves the file', orphan.projects, 0);
eq('and the local list', orphan.localProjects, 0);
eq('its task is kept', orphan.taskKept, true);
eq('with the dangling reference dropped', orphan.detachedInFile, true);
eq('locally too', orphan.detachedLocally, true);

r.section('17. Old deletions stop being carried');
await run(`await f.reset();`);
const horizon = await run(`
  const old = await f.task('ancient');
  await f.B.recordGrave('task', old.uid);
  await f.db.tasks.delete(old.id);
  const fresh = await f.task('recent');
  await f.B.recordGrave('task', fresh.uid);
  await f.db.tasks.delete(fresh.id);
  // Age the first deletion past the horizon.
  const graves = await f.db.graveyard.toArray();
  const first = graves.find(g => g.uid === old.uid);
  await f.db.graveyard.update(first.id, { deletedAt: Date.now() - f.B.DELETION_HORIZON_MS - 1000 });
  await f.run(Date.now());
  const doc = f.doc();
  return { kept: doc.deletions.length, uid: doc.deletions[0]?.uid === fresh.uid };
`);
eq('only the recent deletion is carried', horizon.kept, 1);
eq('and it is the right one', horizon.uid, true);

r.section('18. Repeating a delete does not stack up graves');
await run(`await f.reset();`);
const dupes = await run(`
  const task = await f.task('once');
  await f.B.recordGrave('task', task.uid);
  const firstStamp = (await f.db.graveyard.toArray())[0].deletedAt;
  await new Promise(z => setTimeout(z, 5));
  await f.B.recordGrave('task', task.uid);
  const graves = await f.db.graveyard.toArray();
  return { count: graves.length, unchanged: graves[0].deletedAt === firstStamp };
`);
eq('there is one grave, not two', dupes.count, 1);
eq('and it keeps the first timestamp', dupes.unchanged, true);

r.section('19. Repository input is read the way people paste it');
const parsed = await run(`
  return ['owner/repo', 'https://github.com/owner/repo', 'https://github.com/owner/repo.git',
          'git@github.com:owner/repo.git', '  owner/repo  ', 'nonsense', ''].map(s => {
    const out = f.B.parseRepoInput(s);
    return out ? out.owner + '/' + out.repo : null;
  });
`);
eq('every real shape is understood', parsed, [
  'owner/repo',
  'owner/repo',
  'owner/repo',
  'owner/repo',
  'owner/repo',
  null,
  null,
]);

r.section('20. Merging is stable, so two devices agree');
const converge = await run(`
  const a = { app: 'nextwise', version: 2, savedAt: 'x', deletions: [], projects: [],
    tasks: [{ uid: 'u2', title: 'b', notes: '', domain: 'work', priority: 2, estimateMin: 30,
      focusLevel: 'medium', status: 'todo', tags: [], createdAt: 1, updatedAt: 10 }] };
  const b = { app: 'nextwise', version: 2, savedAt: 'y', deletions: [], projects: [],
    tasks: [{ uid: 'u1', title: 'a', notes: '', domain: 'work', priority: 2, estimateMin: 30,
      focusLevel: 'medium', status: 'todo', tags: [], createdAt: 1, updatedAt: 10 }] };
  const one = f.B.mergeSnapshots(a, b, 1000).merged;
  const two = f.B.mergeSnapshots(b, a, 2000).merged;
  return {
    sameOrder: JSON.stringify(one.tasks) === JSON.stringify(two.tasks),
    sameBoard: f.B.sameBoard(one, two),
    order: one.tasks.map(x => x.uid),
  };
`);
eq('merging either way round gives the same document', converge.sameOrder, true);
eq('which the comparison agrees on', converge.sameBoard, true);
eq('and the order is by identity, not arrival', converge.order, ['u1', 'u2']);

// The file the user downloads and the file in the repository are the same
// document, so a restore has to be able to rebuild the board from it alone —
// including the deletions, which is exactly what the old export dropped.
r.section('21. A downloaded file restores the board it came from');
await run(`await f.reset();`);
const restore = await run(`
  const p = await f.project('Platform', { updatedAt: 1000 });
  await f.task('kept', { projectId: p.id, notes: 'https://example.com', tags: ['a'], updatedAt: 1000 });
  const blocker = await f.task('blocker', { updatedAt: 1000 });
  const waiting = await f.task('waiting', { updatedAt: 1000 });
  await f.db.tasks.update(waiting.id, { blockedBy: blocker.id });
  const doomed = await f.task('doomed', { updatedAt: 1000 });
  await f.B.recordGrave('task', doomed.uid);
  await f.db.tasks.delete(doomed.id);

  // Export.
  const downloaded = JSON.stringify(await f.B.readLocal(2000), null, 2);

  // Import, into a database emptied the way the panel empties it.
  await f.db.tasks.clear();
  await f.db.projects.clear();
  await f.db.graveyard.clear();
  await f.B.applySnapshot(f.B.parseSnapshot(downloaded));

  const tasks = await f.db.tasks.toArray();
  const projects = await f.db.projects.toArray();
  const restoredBlocker = tasks.find(x => x.title === 'blocker');
  const restoredWaiting = tasks.find(x => x.title === 'waiting');
  const restoredKept = tasks.find(x => x.title === 'kept');
  return {
    titles: tasks.map(x => x.title).sort(),
    projects: projects.map(x => x.name),
    filed: restoredKept.projectId === projects[0].id,
    // Ids are handed out afresh on import, so this only holds if the link was
    // carried by identity rather than by the number it happened to have.
    blocked: restoredWaiting.blockedBy === restoredBlocker.id,
    reassigned: restoredBlocker.id !== blocker.id || restoredWaiting.id !== waiting.id,
    notes: restoredKept.notes,
    tags: restoredKept.tags,
    graves: (await f.db.graveyard.toArray()).map(g => g.uid),
    doomedUid: doomed.uid,
  };
`);
eq('every surviving task comes back', restore.titles, ['blocker', 'kept', 'waiting']);
eq('and its project', restore.projects, ['Platform']);
eq('with the task still filed under it', restore.filed, true);
eq('the deleted task stays deleted', restore.titles.includes('doomed'), false);
eq('and is still remembered as deleted', restore.graves, [restore.doomedUid]);
eq('local ids were handed out afresh', restore.reassigned, true);
eq('yet the dependency still points at the right task', restore.blocked, true);
eq('links in notes survive', restore.notes, 'https://example.com');
eq('and tags', restore.tags, ['a']);

// A file written before portable ids existed has to import rather than be
// refused: it is the only copy some boards have.
r.section('22. An older export is still readable');
await run(`await f.reset();`);
const legacy = await run(`
  let refused = false, recognised = false;
  try {
    f.B.parseSnapshot(JSON.stringify({
      app: 'personal-productivity', version: 1, exportedAt: '2025-01-01',
      projects: [], tasks: [],
    }));
  } catch (e) {
    refused = true;
    recognised = e instanceof f.B.SnapshotFormatError;
  }

  // The fallback the panel takes when that happens: load the rows as they are,
  // then give anything without an identity one.
  const id = await f.db.tasks.add({
    title: 'from an old file', notes: '', domain: 'work', priority: 2, estimateMin: 30,
    focusLevel: 'medium', status: 'todo', tags: [], createdAt: 1, updatedAt: 1,
  });
  await f.db.tasks.update(id, { uid: undefined });
  const before = (await f.db.tasks.get(id)).uid;
  const filled = await f.B.backfillUids();
  const after = (await f.db.tasks.get(id)).uid;

  // And once it has one it belongs in the file like anything else.
  await f.run(3000);
  return {
    refused, recognised, filled, before,
    given: typeof after === 'string' && after.length > 0,
    inFile: f.doc().tasks.map(x => x.title),
  };
`);
eq('a v1 document is not mistaken for the new one', legacy.refused, true);
eq('and says so in a way the importer can act on', legacy.recognised, true);
eq('a row without an identity is found', legacy.before, undefined);
eq('and given one', [legacy.filled, legacy.given], [1, true]);
eq('after which it reaches the file like anything else', legacy.inFile, ['from an old file']);


// The fake store proves the merge logic; it says nothing about whether the real
// client asks GitHub the right question. A wrong URL or a missing sha is a 404
// or a silent overwrite, neither of which the user can diagnose.
r.section('23. The real client asks GitHub for the right thing');
const wire = await run(`
  const calls = [];
  const real = window.fetch;
  window.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
    if (init.method === 'PUT') {
      return new Response(JSON.stringify({ content: { sha: 'written' } }), { status: 200 });
    }
    return new Response(JSON.stringify({
      encoding: 'base64', sha: 'abc123',
      content: btoa(JSON.stringify({ app: 'nextwise', version: 2, savedAt: 1, projects: [], tasks: [], deletions: [] })),
    }), { status: 200 });
  };
  try {
    const store = f.B.githubStore(
      { owner: 'me', repo: 'my data', branch: 'trunk', path: 'nextwise/board.json' },
      'github_pat_x',
    );
    const got = await store.read();
    const put = await store.write('{}', got.sha, 'a message');
    const body = JSON.parse(calls[1].body);
    return {
      readUrl: calls[0].url,
      readMethod: calls[0].method,
      auth: calls[0].headers.Authorization,
      version: calls[0].headers['X-GitHub-Api-Version'],
      sha: got.sha,
      writeUrl: calls[1].url,
      writeMethod: calls[1].method,
      sentSha: body.sha,
      sentBranch: body.branch,
      sentMessage: body.message,
      sentContent: atob(body.content),
      newSha: put.sha,
    };
  } finally {
    window.fetch = real;
  }
`);
eq('the file is read from the contents API', wire.readUrl,
  'https://api.github.com/repos/me/my%20data/contents/nextwise/board.json?ref=trunk');
eq('with a GET', wire.readMethod, 'GET');
eq('the token is sent as a bearer', wire.auth, 'Bearer github_pat_x');
eq('and the API version is pinned', wire.version, '2022-11-28');
eq('the blob id comes back for the next write', wire.sha, 'abc123');
// The path is a path, not one escaped name: encoding the slash would create a
// file literally called "nextwise/board.json" in the root.
eq('slashes in the path stay slashes', wire.writeUrl,
  'https://api.github.com/repos/me/my%20data/contents/nextwise/board.json');
eq('saving is a PUT', wire.writeMethod, 'PUT');
// Without this GitHub accepts the write unconditionally and the other device's
// changes disappear with no conflict to retry.
eq('the write is conditional on what was read', wire.sentSha, 'abc123');
eq('and names the branch', wire.sentBranch, 'trunk');
eq('the commit message travels', wire.sentMessage, 'a message');
eq('the body round-trips through base64', wire.sentContent, '{}');
eq('and the new blob id is kept', wire.newSha, 'written');

r.section('24. GitHub saying no is explained rather than repeated');
const refusals = await run(`
  const real = window.fetch;
  const out = {};
  const attempt = async (status, body) => {
    window.fetch = async () => new Response(JSON.stringify(body), { status });
    const store = f.B.githubStore({ owner: 'me', repo: 'r', branch: 'main', path: 'b.json' }, 'tok');
    try { await store.read(); return 'no error'; }
    catch (e) { return e.constructor.name + '|' + e.message; }
  };
  try {
    out.missing = await (async () => {
      window.fetch = async () => new Response('', { status: 404 });
      const store = f.B.githubStore({ owner: 'me', repo: 'r', branch: 'main', path: 'b.json' }, 'tok');
      return await store.read();
    })();
    out.badToken = await attempt(401, { message: 'Bad credentials' });
    out.noScope = await attempt(403, { message: 'Resource not accessible' });
    out.other = await attempt(500, { message: 'Server Error' });
  } finally {
    window.fetch = real;
  }
  let notConfigured = '';
  try { f.B.githubStore({ owner: '', repo: '', branch: 'main', path: 'b.json' }, 'tok'); }
  catch (e) { notConfigured = e.constructor.name; }
  return { ...out, notConfigured };
`);
// A file that is not there yet is the normal first run, not a failure.
eq('a missing file reads as nothing, not an error', refusals.missing, null);
eq('a bad token says so', refusals.badToken, 'BackupAuthError|GitHub rejected the token: Bad credentials');
eq('a token without the permission says which one', refusals.noScope,
  'BackupAuthError|The token is not allowed to do that: Resource not accessible. It needs Contents: read and write on this repository.');
eq("anything else carries GitHub's own words", refusals.other,
  'BackupError|Could not read the file: Server Error');
eq('and an unset repository is caught before any request', refusals.notConfigured, 'BackupNotConfiguredError');

await run(`await f.reset();`);
r.done();
