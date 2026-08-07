// Whether a task can be started at all: its context, what it is blocked on, and
// the date before which there is no point looking at it.
//
// These three are different in kind from priority or estimate. Those rank a
// task; these decide whether it is a candidate in the first place, so the thing
// worth testing hardest is the *exclusions* — a task wrongly hidden is far
// worse than one wrongly shown, because nothing on screen explains its absence.
import { connect, reporter } from './lib.mjs';

const t = await connect();
const r = reporter();
const js = t.js;
const wait = (ms) => new Promise((z) => setTimeout(z, ms));
const eq = (n, a, e) =>
  r.ok(n, JSON.stringify(a) === JSON.stringify(e), `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);

// A page-side harness so each scenario is a single round-trip. Re-installed
// after every navigation, since a reload takes `window.__f` with it.
const install = () => js(`(async () => { window.__f = await (async () => {
  const { db, runSync, FakeGraphClient, FakeGoogleClient, msProvider, googleProvider, footer } = window.__fb;
  const avail = await import('/src/availability.ts');
  const rec = await import('/src/recommender.ts');
  const dates = await import('/src/dates.ts');
  const now = () => Date.now();
  const T = (p = {}) => ({ title:'t', notes:'', domain:'work', priority:2, estimateMin:30,
    focusLevel:'medium', status:'todo', tags:[], createdAt:now(), updatedAt:now(), ...p });
  return {
    db, runSync, FakeGraphClient, FakeGoogleClient, msProvider, googleProvider, footer,
    avail, rec, dates, T,
    map: (tasks) => avail.indexTasks(tasks),
    async reset() {
      await db.tasks.clear(); await db.projects.clear();
      await db.tombstones.clear(); await db.syncState.clear(); await db.syncLinks.clear();
    },
    async byTitle(title) { return (await db.tasks.toArray()).find(x => x.title === title); },
    titles(scored) { return scored.map(s => s.task.title); },
  };
})(); return 'ready'; })()`);

await install();

const run = (body) => js(`(async () => { const f = window.__f; ${body} })()`);

const SITUATION = `{ availableMin: 120, focus: 'deep', domain: 'both', projectId: 'all' }`;

r.section('1. What counts as blocked');
{
  const v = await run(`
    const a = f.T({ id: 1, title: 'Blocker' });
    const done = f.T({ id: 2, title: 'Finished blocker', status: 'done' });
    const byId = f.map([a, done]);
    return {
      clean: f.avail.isBlocked(f.T({ id: 3 }), byId),
      note: f.avail.isBlocked(f.T({ id: 3, blockedNote: 'Dana' }), byId),
      blankNote: f.avail.isBlocked(f.T({ id: 3, blockedNote: '   ' }), byId),
      openTask: f.avail.isBlocked(f.T({ id: 3, blockedBy: 1 }), byId),
      doneTask: f.avail.isBlocked(f.T({ id: 3, blockedBy: 2 }), byId),
      danglingTask: f.avail.isBlocked(f.T({ id: 3, blockedBy: 99 }), byId),
      reasonTask: f.avail.blockedReason(f.T({ id: 3, blockedBy: 1 }), byId),
      reasonNote: f.avail.blockedReason(f.T({ id: 3, blockedNote: 'a delivery' }), byId),
      reasonNone: f.avail.blockedReason(f.T({ id: 3 }), byId),
    };
  `);
  eq('an ordinary task is not blocked', v.clean, false);
  eq('a "waiting on" note blocks it', v.note, true);
  eq('whitespace is not a note', v.blankNote, false);
  eq('an open blocking task blocks it', v.openTask, true);
  // Completing the blocker is the whole point of linking tasks rather than
  // typing a note: it unblocks without anyone remembering to come back.
  eq('finishing the blocker releases it', v.doneTask, false);
  // A deleted blocker must not hide a task forever with nothing to click.
  eq('a deleted blocker releases it', v.danglingTask, false);
  eq('the reason names the blocking task', v.reasonTask, 'Waiting on “Blocker”');
  eq('the reason quotes the note', v.reasonNote, 'Waiting on a delivery');
  eq('an unblocked task has no reason', v.reasonNone, undefined);
}

r.section('2. Not before');
{
  const v = await run(`
    const today = f.dates.todayISO();
    return {
      none: f.avail.isDeferred(f.T({}), today),
      past: f.avail.isDeferred(f.T({ startDate: f.dates.addDays(today, -1) }), today),
      today: f.avail.isDeferred(f.T({ startDate: today }), today),
      future: f.avail.isDeferred(f.T({ startDate: f.dates.addDays(today, 1) }), today),
    };
  `);
  eq('no start date is never deferred', v.none, false);
  eq('yesterday is startable', v.past, false);
  // Inclusive: "not before Friday" means Friday is fine, and an exclusive
  // reading would silently cost the user the whole first day.
  eq('the start date itself is startable', v.today, false);
  eq('tomorrow is still deferred', v.future, true);
}

r.section('3. Context is a constraint, not a preference');
{
  const v = await run(`
    const at = (where, ctx) => f.avail.contextExcludes(f.T({ context: ctx }), where);
    return {
      anywhereUser: at('any', 'phone'),
      undefinedUser: at(undefined, 'phone'),
      match: at('phone', 'phone'),
      mismatch: at('phone', 'office'),
      unlabelled: at('phone', undefined),
    };
  `);
  eq('"anywhere" excludes nothing', v.anywhereUser, false);
  eq('an unset situation excludes nothing', v.undefinedUser, false);
  eq('a matching context is allowed', v.match, false);
  eq('a different context is excluded', v.mismatch, true);
  // The rule that keeps the feature opt-in: labelling some tasks must not
  // silently demote everything you never got round to labelling.
  eq('a task needing nothing is always allowed', v.unlabelled, false);
}

r.section('4. Cycles can never be created');
{
  const v = await run(`
    // 1 <- 2 <- 3 : task 3 is blocked by 2, which is blocked by 1.
    const tasks = [f.T({ id: 1 }), f.T({ id: 2, blockedBy: 1 }), f.T({ id: 3, blockedBy: 2 })];
    const byId = f.map(tasks);
    const free = f.T({ id: 4, title: 'Unrelated' });
    return {
      self: f.avail.wouldCycle(1, 1, byId),
      direct: f.avail.wouldCycle(1, 2, byId),
      transitive: f.avail.wouldCycle(1, 3, byId),
      downstream: f.avail.wouldCycle(3, 1, byId),
      unrelated: f.avail.wouldCycle(1, 4, f.map([...tasks, free])),
      offered: f.avail.blockerCandidates(f.T({ id: 1 }), [...tasks, free]).map(x => x.id),
      offeredForNew: f.avail.blockerCandidates(undefined, [...tasks, free]).map(x => x.id),
    };
  `);
  eq('a task cannot block itself', v.self, true);
  eq('its direct dependent cannot block it', v.direct, true);
  eq('nor can a dependent two hops away', v.transitive, true);
  eq('but its own blocker still can', v.downstream, false);
  eq('an unrelated task is fine', v.unrelated, false);
  eq('the picker offers only safe choices', v.offered, [4]);
  eq('a brand new task may pick anything open', v.offeredForNew, [1, 2, 3, 4]);
}

r.section('5. The recommender withholds what cannot be done');
{
  const v = await run(`
    await f.reset();
    const today = f.dates.todayISO();
    const blockerId = await f.db.tasks.add(f.T({ title: 'Order the washer', priority: 4 }));
    await f.db.tasks.add(f.T({ title: 'Ready', priority: 3 }));
    await f.db.tasks.add(f.T({ title: 'Waiting on a person', priority: 1, blockedNote: 'Dana' }));
    await f.db.tasks.add(f.T({ title: 'Waiting on a task', priority: 1, blockedBy: blockerId }));
    await f.db.tasks.add(f.T({ title: 'Next week', priority: 1, startDate: f.dates.addDays(today, 5) }));
    await f.db.tasks.add(f.T({ title: 'Startable today', priority: 3, startDate: today }));
    const tasks = await f.db.tasks.toArray();
    const ranked = f.rec.recommend(tasks, ${SITUATION});
    return {
      shown: f.titles(ranked),
      held: f.rec.withheld(tasks, ${SITUATION}),
      blockerId,
    };
  `);
  // All three excluded tasks are P1 and would otherwise lead the list, which is
  // exactly the failure this is guarding against.
  r.ok('a task blocked by a note is withheld', !v.shown.includes('Waiting on a person'), v.shown.join(','));
  r.ok('a task blocked by a task is withheld', !v.shown.includes('Waiting on a task'), v.shown.join(','));
  r.ok('a task that cannot start yet is withheld', !v.shown.includes('Next week'), v.shown.join(','));
  r.ok('a task startable today is shown', v.shown.includes('Startable today'), v.shown.join(','));
  r.ok('an ordinary task is shown', v.shown.includes('Ready'), v.shown.join(','));
  eq('and the shortfall is counted, not hidden', v.held, { blocked: 2, deferred: 1, wrongContext: 0 });
}

r.section('6. Completing a blocker releases its dependent');
{
  const v = await run(`
    const blocker = await f.byTitle('Order the washer');
    await f.db.tasks.update(blocker.id, { status: 'done', completedAt: Date.now() });
    const tasks = await f.db.tasks.toArray();
    return {
      shown: f.titles(f.rec.recommend(tasks, ${SITUATION})),
      held: f.rec.withheld(tasks, ${SITUATION}),
    };
  `);
  r.ok('the dependent is now recommendable', v.shown.includes('Waiting on a task'), v.shown.join(','));
  eq('only the note-blocked one is still held', v.held.blocked, 1);
}

r.section('7. Where you are filters and rewards');
{
  const v = await run(`
    await f.reset();
    await f.db.tasks.add(f.T({ title: 'Call the dentist', context: 'phone', priority: 3 }));
    await f.db.tasks.add(f.T({ title: 'Refactor the parser', context: 'laptop', priority: 3 }));
    await f.db.tasks.add(f.T({ title: 'Think about Q3', priority: 3 }));
    const tasks = await f.db.tasks.toArray();
    const onPhone = { ...${SITUATION}, context: 'phone' };
    const anywhere = { ...${SITUATION}, context: 'any' };
    const scoredPhone = f.rec.recommend(tasks, onPhone);
    return {
      anywhere: f.titles(f.rec.recommend(tasks, anywhere)),
      onPhone: f.titles(scoredPhone),
      held: f.rec.withheld(tasks, onPhone),
      phoneReasons: scoredPhone.find(s => s.task.title === 'Call the dentist').reasons.map(x => x.label),
      phonePoints: scoredPhone.find(s => s.task.title === 'Call the dentist').reasons
        .filter(x => x.label.startsWith('Doable')).map(x => x.points),
      neutralReasons: scoredPhone.find(s => s.task.title === 'Think about Q3').reasons
        .filter(x => x.label.startsWith('Doable')).length,
      order: f.titles(scoredPhone),
    };
  `);
  eq('"anywhere" shows everything', v.anywhere.length, 3);
  eq('being on a phone hides the laptop work', v.onPhone.sort(), ['Call the dentist', 'Think about Q3']);
  eq('and says so', v.held, { blocked: 0, deferred: 0, wrongContext: 1 });
  // Constraint: every signal that moves a task has to appear in the explanation.
  r.ok('the match is explained', v.phoneReasons.includes('Doable from your phone'), v.phoneReasons.join(' | '));
  eq('and is worth points', v.phonePoints, [10]);
  eq('a context-free task is neither rewarded nor punished', v.neutralReasons, 0);
  eq('so the matching task leads', v.order[0], 'Call the dentist');
}

r.section('8. The notes footer carries them between devices');
{
  const v = await run(`
    const full = f.footer.buildFooter({ estimateMin: 45, focusLevel: 'deep', priority: 2, domain: 'work',
      context: 'errand', startDate: '2026-03-01', blockedNote: "Dana's reply", tags: ['a b'] });
    const bare = f.footer.buildFooter({ estimateMin: 30, focusLevel: 'medium', priority: 3, domain: 'personal' });
    return {
      full,
      bare,
      parsedFull: f.footer.parseFooter(full),
      roundTrip: f.footer.splitBody('Some prose.\\n\\n' + full),
      badContext: f.footer.parseFooter('[fb] ctx=spaceship'),
      badStart: f.footer.parseFooter('[fb] start=2026-02-30'),
      badStartShape: f.footer.parseFooter('[fb] start=soon'),
      emptyNote: f.footer.buildFooter({ estimateMin: 30, focusLevel: 'medium', priority: 3, domain: 'work', blockedNote: '' }),
    };
  `);
  r.ok('context rides along', v.full.includes('ctx=errand'), v.full);
  r.ok('so does the earliest start', v.full.includes('start=2026-03-01'), v.full);
  // The footer is split on whitespace, so anything with a space in it has to be
  // encoded or it truncates every field after it.
  r.ok('the waiting-on note is encoded', v.full.includes("wait=Dana's%20reply"), v.full);
  eq('nothing after it is lost', v.parsedFull.tags, ['a b']);
  eq('and it decodes back', v.parsedFull.blockedNote, "Dana's reply");
  eq('context decodes back', v.parsedFull.context, 'errand');
  eq('start date decodes back', v.parsedFull.startDate, '2026-03-01');
  // Older footers, and unconstrained tasks, must produce byte-identical output
  // or every task in the account would be rewritten on the next sync.
  eq('an unconstrained task writes the footer it always did', v.bare,
    '[fb] est=30m focus=medium prio=P3 area=personal');
  eq('an empty note adds nothing', v.emptyNote, '[fb] est=30m focus=medium prio=P3 area=work');
  eq('prose above the footer is untouched', v.roundTrip.notes, 'Some prose.');
  eq('an unknown context is ignored', v.badContext.context, undefined);
  eq('an impossible date is ignored', v.badStart.startDate, undefined);
  eq('a non-date is ignored', v.badStartShape.startDate, undefined);
}

r.section('9. A full round-trip through Microsoft To Do');
{
  const v = await run(`
    await f.reset();
    await f.db.tasks.add(f.T({ title: 'Post the parcel', domain: 'work', context: 'errand',
      startDate: '2026-05-04', blockedNote: 'the shipping label' }));
    const client = new f.FakeGraphClient({ withDefaultList: true });
    const first = await f.runSync(f.msProvider(client));
    const second = await f.runSync(f.msProvider(client));

    // A second device: same account, empty board.
    const remoteBody = client.findTaskByTitle('Post the parcel').body.content;
    await f.db.tasks.clear(); await f.db.syncLinks.clear(); await f.db.syncState.clear();
    await f.runSync(f.msProvider(client));
    const pulled = await f.byTitle('Post the parcel');
    return {
      first, second, remoteBody,
      pulled: pulled && { context: pulled.context, startDate: pulled.startDate,
        blockedNote: pulled.blockedNote, notes: pulled.notes },
    };
  `);
  r.ok('the push succeeded', v.first.ok === true, JSON.stringify(v.first.errors));
  r.ok('the footer carries all three', /ctx=errand start=2026-05-04 wait=the%20shipping%20label/.test(v.remoteBody), v.remoteBody);
  // If fieldsMatch ignored the new fields this would still pass; the pull below
  // is what proves they actually made it across.
  eq('re-syncing changes nothing', [v.second.pushed.updated, v.second.pushed.created], [0, 0]);
  eq('a fresh device gets the context', v.pulled.context, 'errand');
  eq('and the earliest start', v.pulled.startDate, '2026-05-04');
  eq('and what it is waiting on', v.pulled.blockedNote, 'the shipping label');
  eq('without the footer leaking into the notes', v.pulled.notes, '');
}

r.section('10. And through Google Tasks');
{
  const v = await run(`
    await f.reset();
    await f.db.tasks.add(f.T({ title: 'Water the plants', domain: 'personal', context: 'home',
      startDate: '2026-06-01' }));
    const client = new f.FakeGoogleClient({ withDefaultList: true });
    await f.runSync(f.googleProvider(client));
    const idle = await f.runSync(f.googleProvider(client));

    // Change only the context: nothing else about the task moves.
    const local = await f.byTitle('Water the plants');
    await new Promise(z => setTimeout(z, 3));
    await f.db.tasks.update(local.id, { context: 'errand', updatedAt: Date.now() });
    const after = await f.runSync(f.googleProvider(client));
    const remote = client.findTaskByTitle('Water the plants');
    return { idle, after, notes: remote.notes };
  `);
  eq('an unchanged task is not rewritten', v.idle.pushed.updated, 0);
  // The regression this catches: a skip-if-equal check that does not know about
  // a field can never push a change to it, and the edit is lost in silence.
  eq('changing only the context does push', v.after.pushed.updated, 1);
  r.ok('and the remote footer reflects it', /ctx=errand/.test(v.notes), v.notes);
  r.ok('the start date survived alongside', /start=2026-06-01/.test(v.notes), v.notes);
}

r.section('11. jAIme can set and respect them');
{
  const v = await js(`(async () => {
    const f = window.__f;
    const { chatTools } = window.__fb;
    await f.reset();
    let situation = { availableMin: 60, focus: 'medium', domain: 'both', projectId: 'all', context: 'any' };
    const deps = { getContext: () => situation, setContext: (p) => { situation = { ...situation, ...p }; } };
    const call = (name, input) => chatTools.executeTool(name, input, deps);

    const blocker = await call('create_task', { title: 'Get the quote', area: 'work' });
    const made = await call('create_task', { title: 'Book the venue', area: 'work',
      context: 'phone', startDate: '2026-09-01', blockedBy: blocker.created.id });
    const other = await call('create_task', { title: 'Deep work block', area: 'work', context: 'laptop' });

    let cycle = null;
    try { await call('update_task', { id: blocker.created.id, blockedBy: made.created.id }); }
    catch (e) { cycle = e.message; }

    let ghost = null;
    try { await call('update_task', { id: other.created.id, blockedBy: 99999 }); }
    catch (e) { ghost = e.message; }

    const listed = await call('list_tasks', { onlyReady: true });
    const onPhone = await call('recommend', { where: 'phone' });
    await call('set_context', { where: 'office' });
    const cleared = await call('update_task', { id: made.created.id, blockedBy: 0, startDate: '', context: '' });
    const raw = await f.byTitle('Book the venue');
    return {
      made: made.created,
      cycle, ghost,
      ready: listed.tasks.map(x => x.title),
      heldBack: onPhone.heldBack,
      phoneTop: onPhone.top.map(x => x.title),
      where: situation.context,
      cleared: cleared.updated,
      rawKeys: Object.keys(raw).filter(k => ['context','startDate','blockedBy'].includes(k)),
    };
  })()`);
  eq('it can create with all three', [v.made.context, v.made.notBefore, v.made.blocked],
    ['phone', '2026-09-01', 'Waiting on “Get the quote”']);
  r.ok('a circular dependency is refused', /circular/.test(v.cycle ?? ''), String(v.cycle));
  r.ok('a made-up blocker id is refused', /No task with id 99999/.test(v.ghost ?? ''), String(v.ghost));
  eq('onlyReady drops the blocked one', v.ready.sort(), ['Deep work block', 'Get the quote']);
  eq('recommending on a phone hides laptop work', v.phoneTop, ['Get the quote']);
  eq('and it is told why', v.heldBack, { blocked: 1, deferred: 0, wrongContext: 1 });
  eq('it can move the user somewhere else', v.where, 'office');
  eq('and clear all three again',
    [v.cleared.context, v.cleared.notBefore, v.cleared.blocked], [undefined, undefined, undefined]);
  // Dexie's update() silently ignores undefined, so clearing has to delete the
  // key outright or the old value survives.
  eq('the keys are really gone from the record', v.rawKeys, []);
}

r.section('12. On screen');
{
  await run(`
    await f.reset();
    // A project has to exist or the reload below re-seeds the demo board on top
    // of these fixtures.
    await f.db.projects.add({ name: 'Move', domain: 'work', color: '#888', createdAt: Date.now() });
    const blockerId = await f.db.tasks.add(f.T({ title: 'Approve the budget', domain: 'work', priority: 3 }));
    await f.db.tasks.add(f.T({ title: 'Sign the lease', domain: 'work', priority: 1, blockedBy: blockerId }));
    await f.db.tasks.add(f.T({ title: 'Chase the invoice', domain: 'work', priority: 1, blockedNote: 'accounts' }));
    await f.db.tasks.add(f.T({ title: 'Rewrite the readme', domain: 'work', priority: 2, context: 'laptop' }));
    await f.db.tasks.add(f.T({ title: 'Collect the keys', domain: 'work', priority: 1, context: 'errand',
      startDate: f.dates.addDays(f.dates.todayISO(), 4) }));
    return 'seeded';
  `);
  await js(`localStorage.setItem('pp.context.v1', JSON.stringify(
    { availableMin: 120, focus: 'deep', domain: 'work', projectId: 'all', context: 'any' })); 'ok'`);
  await t.send('Page.navigate', { url: t.url });
  await wait(2600);
  await install();

  const focus = await js(`(() => {
    const withheldEl = document.querySelector('[data-withheld]');
    const top = document.querySelector('main div.overflow-hidden');
    return {
      withheld: withheldEl?.innerText.trim() ?? null,
      topPick: top?.innerText.split('\\n').find(l => l.trim().length > 0 && !l.includes('score')) ?? null,
      body: document.querySelector('main').innerText,
    };
  })()`);
  r.ok('the Focus tab accounts for what it held back',
    /3 tasks held back/.test(focus.withheld ?? ''), String(focus.withheld));
  r.ok('naming both reasons', /2 blocked/.test(focus.withheld ?? '') && /1 not startable yet/.test(focus.withheld ?? ''),
    String(focus.withheld));
  r.ok('neither blocked P1 is recommended',
    !focus.body.includes('Sign the lease') && !focus.body.includes('Chase the invoice'), focus.body.slice(0, 400));
  r.ok('nor the one that cannot start yet', !focus.body.includes('Collect the keys'), focus.body.slice(0, 400));

  // Narrow the situation and the laptop task should drop out too.
  const filtered = await js(`(async () => {
    const sel = [...document.querySelectorAll('main select')]
      .find(s => [...s.options].some(o => o.value === 'errand') && [...s.options].some(o => o.value === 'any'));
    sel.value = 'errand';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(z => setTimeout(z, 400));
    return document.querySelector('main').innerText;
  })()`);
  r.ok('going out hides the laptop task', !filtered.includes('Rewrite the readme'), filtered.slice(0, 400));
  r.ok('and explains that too', /needs somewhere else/.test(filtered), filtered.slice(0, 600));

  await js(`(async () => {
    const sel = [...document.querySelectorAll('main select')]
      .find(s => [...s.options].some(o => o.value === 'errand') && [...s.options].some(o => o.value === 'any'));
    sel.value = 'any';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(z => setTimeout(z, 300));
    [...document.querySelectorAll('nav button')].find(b => b.innerText.trim() === 'Tasks').click();
    await new Promise(z => setTimeout(z, 400));
    return 'ok';
  })()`);

  const rows = await js(`(() => {
    const main = document.querySelector('main');
    return {
      badges: [...main.querySelectorAll('[data-task-blocked]')].map(d => d.innerText.replace(/\\s+/g, ' ').trim()),
      contexts: [...main.querySelectorAll('[data-task-context]')].map(s => s.innerText.trim()),
      starts: [...main.querySelectorAll('[data-task-start]')].map(s => s.innerText.trim()),
      railsMuted: [...main.querySelectorAll('[data-priority-rail="1"]')].length,
    };
  })()`);
  eq('both blocked tasks are badged', rows.badges.length, 2);
  r.ok('the badge names the blocking task',
    rows.badges.some(b => b.includes('Waiting on “Approve the budget”')), JSON.stringify(rows.badges));
  r.ok('and the free-text one', rows.badges.some(b => b.includes('Waiting on accounts')), JSON.stringify(rows.badges));
  // "@laptop", not "laptop", so it cannot be mistaken for one of the #tags
  // sitting further along the same metadata line.
  eq('contexts render GTD-style', rows.contexts.sort(), ['@errand', '@laptop']);
  eq('a deferred task says when it starts', rows.starts, ['starts in 4 days']);

  const filters = await js(`(async () => {
    const sel = [...document.querySelectorAll('main select')].find(s => [...s.options].some(o => o.value === 'ready'));
    sel.value = 'ready';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(z => setTimeout(z, 300));
    const ready = document.querySelector('main').innerText;
    sel.value = 'blocked';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(z => setTimeout(z, 300));
    return { ready, blocked: document.querySelector('main').innerText };
  })()`);
  r.ok('"Ready now" keeps the actionable ones',
    filters.ready.includes('Rewrite the readme') && filters.ready.includes('Approve the budget'),
    filters.ready.slice(0, 400));
  r.ok('and drops the blocked and deferred ones',
    !filters.ready.includes('Sign the lease') && !filters.ready.includes('Collect the keys'),
    filters.ready.slice(0, 400));
  r.ok('"Blocked" shows exactly the two',
    filters.blocked.includes('Sign the lease') && filters.blocked.includes('Chase the invoice')
      && !filters.blocked.includes('Rewrite the readme'),
    filters.blocked.slice(0, 400));
}

r.section('13. Deleting a blocker releases whatever waited on it');
{
  const v = await js(`(async () => {
    const f = window.__f;
    const confirm = window.confirm;
    window.confirm = () => true;
    const blocker = await f.byTitle('Approve the budget');
    // Show every task again: the previous section left the board on "Blocked",
    // which is exactly where the blocker is not.
    const status = [...document.querySelectorAll('main select')]
      .find(s => [...s.options].some(o => o.value === 'blocked'));
    status.value = 'all';
    status.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(z => setTimeout(z, 400));
    // Match on the row's own title, not its text: a blocked row quotes the
    // title of whatever it is waiting on.
    const row = document.querySelector('[data-task-title="Approve the budget"]');
    // Drive the app's own delete path, which owns the cascade.
    [...row.querySelectorAll('button')].find(b => b.innerText.trim() === 'Delete').click();
    await new Promise(z => setTimeout(z, 500));
    window.confirm = confirm;
    const released = await f.byTitle('Sign the lease');
    return {
      blockerGone: !(await f.byTitle('Approve the budget')),
      dependentKept: !!released,
      stillBlocked: released ? f.avail.isBlocked(released, f.map(await f.db.tasks.toArray())) : null,
      reference: released?.blockedBy ?? null,
      wasBlockedBy: blocker.id,
    };
  })()`);
  eq('the blocker is gone', v.blockerGone, true);
  eq('the dependent survives', v.dependentKept, true);
  // Without the cascade the row would sit blocked forever, pointing at an id
  // the user can no longer see or clear.
  eq('and is no longer blocked', v.stillBlocked, false);
  eq('with the dangling reference removed', v.reference, null);
}

await run(`await f.reset(); return 'clean';`);
const passed = r.done(t.errors);
t.close();
process.exit(passed ? 0 : 1);
