// The focus session: one task, one clock, and nothing else on screen.
//
// The riskiest part of a timer is not the arithmetic, it is what happens around
// it — a reload, a pause, a task finished in another tab, an estimate quietly
// rewritten. So the maths is checked directly and cheaply, and everything that
// touches stored data is driven through the real UI.
import { connect, reporter } from './lib.mjs';

const t = await connect();
const r = reporter();
const js = t.js;
const wait = (ms) => new Promise((z) => setTimeout(z, ms));
const eq = (n, a, e) =>
  r.ok(n, JSON.stringify(a) === JSON.stringify(e), `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);

const install = () => js(`(async () => { window.__s = await (async () => {
  const { db, footer, runSync, FakeGraphClient, msProvider } = window.__fb;
  const S = window.__fb.session;
  const now = () => Date.now();
  const T = (p = {}) => ({ title:'t', notes:'', domain:'work', priority:2, estimateMin:30,
    focusLevel:'medium', status:'todo', tags:[], createdAt:now(), updatedAt:now(), ...p });
  return {
    db, S, footer, runSync, FakeGraphClient, msProvider, T,
    async reset() {
      await db.tasks.clear(); await db.projects.clear();
      await db.tombstones.clear(); await db.syncState.clear(); await db.syncLinks.clear();
      localStorage.removeItem('pp.session.v1');
      // An empty projects table re-seeds the whole demo board on the next load,
      // which would bury the one task each section is about. A placeholder is
      // enough to keep the seed from firing.
      await db.projects.add({ name: 'Holder', domain: 'work', color: '#888',
        createdAt: now(), updatedAt: now(), archived: 0 });
    },
    async byTitle(title) { return (await db.tasks.toArray()).find(x => x.title === title); },
    stored() { return JSON.parse(localStorage.getItem('pp.session.v1') || 'null'); },
    /** Rewind the running clock so a session looks older than it is. */
    ageBy(ms) {
      const s = JSON.parse(localStorage.getItem('pp.session.v1'));
      s.runStartedAt -= ms;
      localStorage.setItem('pp.session.v1', JSON.stringify(s));
      return s;
    },
  };
})(); return 'ready'; })()`);

await install();

const run = (body) => js(`(async () => { const f = window.__s; ${body} })()`);

/** Click a button by its exact visible label, anywhere on the page. */
const click = (label, wrap = 'body') =>
  js(`(() => {
    const b = [...document.querySelectorAll(${JSON.stringify(wrap)} + ' button')]
      .find(x => x.innerText.trim() === ${JSON.stringify(label)});
    if (!b) throw new Error('no button labelled ' + ${JSON.stringify(label)});
    b.click(); return 'ok';
  })()`);

const screen = () => js(`document.querySelector('[data-session]')?.innerText ?? null`);

/**
 * Click a menu entry by its first line. The stuck-menu options carry an
 * explanatory second line, so exact-match on `innerText` never finds them.
 */
const clickOption = (label, wrap = 'body') =>
  js(`(() => {
    const b = [...document.querySelectorAll(${JSON.stringify(wrap)} + ' button')]
      .find(x => x.innerText.trim().split('\\n')[0].trim() === ${JSON.stringify(label)});
    if (!b) throw new Error('no option ' + ${JSON.stringify(label)});
    if (b.disabled) throw new Error('option is disabled: ' + ${JSON.stringify(label)});
    b.click(); return 'ok';
  })()`);

r.section('1. The clock');
{
  const v = await run(`
    const S = f.S;
    const base = S.startSession(7, 25, 1_000_000);
    const min = 60_000;
    return {
      fresh: S.elapsedMs(base, 1_000_000),
      after10: S.elapsedMs(base, 1_000_000 + 10 * min),
      left: S.remainingMs(base, 1_000_000 + 10 * min),
      over: S.remainingMs(base, 1_000_000 + 30 * min),
      isOverBefore: S.isOvertime(base, 1_000_000 + 24 * min),
      isOverAfter: S.isOvertime(base, 1_000_000 + 26 * min),
      face: S.clockLabel(base, 1_000_000 + 10 * min),
      overFace: S.clockLabel(base, 1_000_000 + 26 * min),
      progressHalf: Math.round(S.progress(base, 1_000_000 + 12.5 * min) * 100),
      progressPast: S.progress(base, 1_000_000 + 90 * min),
      spent: S.spentMinutes(base, 1_000_000 + 10 * min + 20_000),
    };
  `);
  eq('a new session starts at zero', v.fresh, 0);
  eq('elapsed follows the wall clock', v.after10, 600_000);
  eq('the plan drains as it goes', v.left, 900_000);
  // Freezing at 00:00 would hide the one thing the timer has to say at that
  // moment, so the remainder is allowed to go negative and the face flips.
  eq('running over goes negative', v.over, -300_000);
  eq('under the plan is not overtime', v.isOverBefore, false);
  eq('past the plan is', v.isOverAfter, true);
  eq('the face counts down', v.face, '15:00');
  eq('and then counts up with a sign', v.overFace, '+1:00');
  eq('progress is the fraction of the plan', v.progressHalf, 50);
  eq('and never exceeds full', v.progressPast, 1);
  eq('spent minutes round to the nearest', v.spent, 10);
}

r.section('2. Pausing banks the time instead of losing it');
{
  const v = await run(`
    const S = f.S;
    const min = 60_000;
    const started = S.startSession(7, 25, 0);
    const paused = S.pauseSession(started, 6 * min);
    const stillPaused = S.elapsedMs(paused, 60 * min);
    const resumed = S.resumeSession(paused, 60 * min);
    return {
      banked: paused.bankedMs,
      frozen: stillPaused,
      afterResume: S.elapsedMs(resumed, 64 * min),
      doublePause: S.pauseSession(paused, 90 * min).bankedMs,
      resumeUnpaused: S.resumeSession(started, 90 * min).runStartedAt,
    };
  `);
  eq('pausing banks what has elapsed', v.banked, 360_000);
  // The clock has to stop *stopped*: a paused session left overnight must not
  // come back claiming eight hours of focus.
  eq('a paused clock does not keep running', v.frozen, 360_000);
  eq('resuming carries the banked time forward', v.afterResume, 600_000);
  eq('pausing twice does not double-count', v.doublePause, 360_000);
  eq('resuming a running session is a no-op', v.resumeUnpaused, 0);
}

r.section('3. Extending');
{
  const v = await run(`
    const S = f.S;
    const once = S.extendSession(S.startSession(7, 30, 0));
    const twice = S.extendSession(once);
    return { planned: once.plannedMin, count: once.extensions,
      twicePlanned: twice.plannedMin, twiceCount: twice.extensions, step: S.EXTEND_MIN };
  `);
  eq('one nudge adds the standard step', v.planned, 40);
  eq('and is counted', v.count, 1);
  eq('nudges accumulate', v.twicePlanned, 50);
  eq('as does the count', v.twiceCount, 2);
  eq('the step is ten minutes', v.step, 10);
}

r.section('4. Starting one from the recommendation');
{
  await run(`
    await f.reset();
    await f.db.projects.add({ name: 'Move', domain: 'work', color: '#888', createdAt: Date.now(), updatedAt: Date.now(), archived: 0 });
    await f.db.tasks.add(f.T({ title: 'Write the rollback plan', priority: 1, estimateMin: 45,
      focusLevel: 'deep', notes: 'Runbook: https://wiki.example.com/roll' }));
    await f.db.tasks.add(f.T({ title: 'Reply to the vendor', priority: 3, estimateMin: 10, focusLevel: 'shallow' }));
    localStorage.setItem('pp.context.v1', JSON.stringify(
      { availableMin: 120, focus: 'deep', domain: 'work', projectId: 'all', context: 'any' }));
    return 'seeded';
  `);
  await t.send('Page.navigate', { url: t.url });
  await wait(2600);
  await install();

  const before = await js(`document.querySelector('main')?.innerText.includes('Reply to the vendor') ?? null`);
  r.ok('the board lists the backlog first', before === true, String(before));

  await click('Start', 'main');
  await wait(600);

  const after = await js(`(() => ({
    session: !!document.querySelector('[data-session]'),
    nav: document.querySelectorAll('nav button').length,
    body: document.body.innerText,
    task: document.querySelector('[data-session-task]')?.getAttribute('data-session-task') ?? null,
    clock: document.querySelector('[data-session-clock]')?.innerText.trim() ?? null,
  }))()`);
  eq('starting opens the session screen', after.session, true);
  // "Remove the backlog" is the feature. If the tabs or the other tasks are
  // still reachable, nothing has actually been removed.
  eq('the tabs are gone', after.nav, 0);
  r.ok('and so is the rest of the backlog', !after.body.includes('Reply to the vendor'),
    after.body.slice(0, 300));
  eq('the chosen task is the one on screen', after.task, 'Write the rollback plan');
  r.ok('the clock starts at the estimate', /^(45:00|44:5\d)$/.test(after.clock ?? ''), String(after.clock));

  const parts = await screen();
  r.ok('its notes come with it', parts.includes('Runbook'), parts.slice(0, 300));
  r.ok('its links are still links',
    (await js(`document.querySelectorAll('[data-session] a[href]').length`)) === 1);
  for (const label of ['Complete', 'Pause', 'I’m stuck', 'This is taking longer']) {
    r.ok(`the ${label} control is there`, parts.includes(label), parts.slice(0, 400));
  }
}

r.section('5. It survives a reload');
{
  const stored = await run(`return f.stored()`);
  eq('the session is persisted', stored.taskId > 0, true);
  eq('with the plan it started with', stored.plannedMin, 45);

  // Wind the clock back four minutes: a reload must resume where it was, not
  // restart, and must not count the time the tab was closed twice.
  await run(`f.ageBy(4 * 60_000); return 'aged'`);
  await t.send('Page.navigate', { url: t.url });
  await wait(2600);
  await install();

  const v = await js(`(() => ({
    session: !!document.querySelector('[data-session]'),
    clock: document.querySelector('[data-session-clock]')?.innerText.trim() ?? null,
    task: document.querySelector('[data-session-task]')?.getAttribute('data-session-task') ?? null,
  }))()`);
  eq('reloading lands back in the session', v.session, true);
  eq('on the same task', v.task, 'Write the rollback plan');
  r.ok('with the clock where it was, not reset', /^4[01]:/.test(v.clock ?? ''), String(v.clock));
}

r.section('6. Pause and resume on screen');
{
  await click('Pause', '[data-session]');
  await wait(400);
  const paused = await run(`return { stored: f.stored(), label: document.querySelector('[data-session]').innerText }`);
  eq('the stored session is paused', paused.stored.paused, true);
  r.ok('and says so', paused.label.toUpperCase().includes('PAUSED'), paused.label.slice(0, 200));
  r.ok('offering to resume', paused.label.includes('Resume'), paused.label.slice(0, 200));

  const held = await js(`document.querySelector('[data-session-clock]').innerText.trim()`);
  await wait(1600);
  const still = await js(`document.querySelector('[data-session-clock]').innerText.trim()`);
  eq('a paused clock does not move', still, held);

  await click('Resume', '[data-session]');
  await wait(400);
  eq('resuming clears the pause', (await run(`return f.stored().paused`)), false);
}

r.section('7. The checklist');
{
  const type = (text) => js(`(() => {
    const i = document.querySelector('[data-session] input[aria-label="Add a checklist step"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(i, ${JSON.stringify(text)});
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`);

  await type('Draft the steps');
  await click('Add', '[data-session]');
  await wait(400);
  await type('Get it reviewed');
  await click('Add', '[data-session]');
  await wait(400);

  const saved = await run(`return (await f.byTitle('Write the rollback plan')).checklist`);
  eq('both steps are stored', saved.map((i) => i.text), ['Draft the steps', 'Get it reviewed']);
  r.ok('with distinct ids', saved[0].id !== saved[1].id, JSON.stringify(saved));
  eq('and start unticked', saved.every((i) => i.done === false), true);

  await js(`(() => {
    document.querySelectorAll('[data-checklist-item] button')[0].click(); return 'ok';
  })()`);
  await wait(400);
  const ticked = await run(`return (await f.byTitle('Write the rollback plan')).checklist`);
  eq('ticking one persists', [ticked[0].done, ticked[1].done], [true, false]);
  eq('the count is shown', await js(`document.querySelector('[data-session]').innerText.match(/1\\/2/)?.[0]`), '1/2');
  eq('and the item is marked', await js(`document.querySelectorAll('[data-checklist-item="done"]').length`), 1);

  await js(`(() => {
    const row = document.querySelectorAll('[data-checklist-item]')[1];
    [...row.querySelectorAll('button')].find(b => b.innerText.trim() === '×').click();
    return 'ok';
  })()`);
  await wait(400);
  eq('removing one leaves the rest',
    (await run(`return (await f.byTitle('Write the rollback plan')).checklist.map(i => i.text)`)),
    ['Draft the steps']);
}

r.section('8. This is taking longer');
{
  await click('This is taking longer', '[data-session]');
  await wait(500);
  const v = await run(`
    const task = await f.byTitle('Write the rollback plan');
    return { planned: f.stored().plannedMin, extensions: f.stored().extensions,
      estimate: task.estimateMin, text: document.querySelector('[data-session]').innerText };
  `);
  eq('the plan grows by ten minutes', v.planned, 55);
  eq('the extension is counted', v.extensions, 1);
  // An estimate that stays wrong makes every future plan built on it wrong the
  // same way, so the correction is written back to the task.
  eq('and the estimate is corrected too', v.estimate, 55);
  r.ok('the screen admits it was extended', /extended 1/.test(v.text), v.text.slice(0, 400));
}

r.section('9. Local-only fields never reach a provider');
{
  const v = await run(`
    const client = new f.FakeGraphClient();
    await f.runSync(f.msProvider, client, { domains: ['work'] });
    const task = await f.byTitle('Write the rollback plan');
    const remote = client.findTaskByTitle
      ? client.findTaskByTitle('Write the rollback plan')
      : (await client.listTasks((await client.listLists()).find(l => true).id)).find(x => x.title === 'Write the rollback plan');
    const body = remote?.body?.content ?? '';
    return {
      hasChecklist: !!task.checklist?.length,
      spent: task.spentMin ?? 0,
      body,
      parsed: f.footer.parseFooter(body),
    };
  `);
  eq('the task really has a checklist locally', v.hasChecklist, true);
  r.ok('but nothing about it is pushed', !/Draft the steps/.test(v.body), v.body);
  r.ok('nor is the time spent', !/spent|spentMin/.test(v.body), v.body);
  // The footer is compared byte for byte on every sync, so a stray key here
  // would rewrite every task in the account.
  r.ok('and the footer keeps only the fields it always had',
    Object.keys(v.parsed.meta ?? v.parsed).every((k) =>
      ['estimateMin', 'focusLevel', 'priority', 'domain', 'tags', 'context', 'startDate', 'blockedNote'].includes(k)),
    JSON.stringify(v.parsed));
}

r.section('10. I’m stuck');
{
  await click('I’m stuck', '[data-session]');
  await wait(400);
  const menu = await js(`document.querySelector('[data-stuck-menu]')?.innerText ?? null`);
  r.ok('the menu offers three ways out', menu !== null, String(menu));
  for (const option of ['Mark it blocked', 'Break it down', 'Something smaller']) {
    r.ok(`including "${option}"`, (menu ?? '').includes(option), String(menu));
  }
  r.ok('and names the smaller task it would swap to',
    (menu ?? '').includes('Reply to the vendor'), String(menu));

  // "Break it down" must not throw the session away: being stuck is a reason to
  // make the task smaller, not to abandon the time already spent on it.
  await clickOption('Break it down', '[data-stuck-menu]');
  await wait(400);
  const after = await js(`(() => ({
    session: !!document.querySelector('[data-session]'),
    menu: !!document.querySelector('[data-stuck-menu]'),
    focused: document.activeElement?.getAttribute('aria-label') ?? null,
  }))()`);
  eq('breaking it down keeps you in the session', after.session, true);
  eq('closes the menu', after.menu, false);
  eq('and puts the cursor in the checklist', after.focused, 'Add a checklist step');
}

r.section('11. Swapping to something smaller');
{
  await click('I’m stuck', '[data-session]');
  await wait(300);
  await clickOption('Something smaller', '[data-stuck-menu]');
  await wait(700);

  const v = await run(`
    const big = await f.byTitle('Write the rollback plan');
    return {
      task: document.querySelector('[data-session-task]')?.getAttribute('data-session-task') ?? null,
      clock: document.querySelector('[data-session-clock]')?.innerText.trim() ?? null,
      storedId: f.stored().taskId,
      bigSpent: big.spentMin ?? 0,
      bigStatus: big.status,
      extensions: f.stored().extensions,
    };
  `);
  eq('the session moves to the shorter task', v.task, 'Reply to the vendor');
  r.ok('with a fresh clock at its own estimate', /^(10:00|9:5\d)$/.test(v.clock ?? ''), String(v.clock));
  eq('and a fresh extension count', v.extensions, 0);
  // The abandoned task keeps the time it consumed; that is the whole reason for
  // recording it. Section 5 wound its clock forward by four minutes.
  r.ok('the time spent on the big one is banked', v.bigSpent >= 4, String(v.bigSpent));
  eq('and it is left open, not completed', v.bigStatus, 'todo');
  eq('and the stuck menu does not follow it across',
    await js(`!!document.querySelector('[data-stuck-menu]')`), false);
}

r.section('12. Parking a task you are waiting on');
{
  await click('I’m stuck', '[data-session]');
  await wait(300);
  await clickOption('Mark it blocked', '[data-stuck-menu]');
  await wait(300);
  await js(`(() => {
    const i = document.querySelector('[data-stuck-blocked] input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(i, 'the vendor to answer');
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`);
  await wait(200);
  await click('Park it', '[data-stuck-blocked]');
  await wait(700);

  const v = await run(`
    const task = await f.byTitle('Reply to the vendor');
    return { note: task.blockedNote, status: task.status, stored: f.stored(),
      session: !!document.querySelector('[data-session]'), body: document.body.innerText };
  `);
  eq('the reason is recorded on the task', v.note, 'the vendor to answer');
  eq('the task stays open', v.status, 'todo');
  eq('the session ends', v.stored, null);
  eq('and the board comes back', v.session, false);
  r.ok('with the task now shown as blocked',
    v.body.includes('Blocked') || v.body.includes('held back'), v.body.slice(0, 400));
}

r.section('13. Completing from the session');
{
  await run(`
    await f.reset();
    await f.db.tasks.add(f.T({ title: 'Send the invoice', priority: 1, estimateMin: 20, focusLevel: 'medium' }));
    return 'seeded';
  `);
  await t.send('Page.navigate', { url: t.url });
  await wait(2600);
  await install();

  await click('Start', 'main');
  await wait(500);
  // `ageBy` rewrites the stored stamp; the running component is still holding
  // the one it started with, so a reload is what makes the age take effect.
  await run(`f.ageBy(3 * 60_000); return 'aged'`);
  await t.send('Page.navigate', { url: t.url });
  await wait(2600);
  await install();
  await click('Complete', '[data-session]');
  await wait(800);

  const v = await run(`
    const task = await f.byTitle('Send the invoice');
    return { status: task.status, completed: !!task.completedAt, spent: task.spentMin ?? 0,
      stored: f.stored(), session: !!document.querySelector('[data-session]'),
      body: document.body.innerText };
  `);
  eq('the task is done', v.status, 'done');
  eq('with a completion stamp', v.completed, true);
  eq('the time spent is kept', v.spent, 3);
  eq('the session is cleared', v.stored, null);
  eq('and the board is back', v.session, false);
  r.ok('with the tabs restored', /Focus/.test(v.body) && /Projects/.test(v.body), v.body.slice(0, 200));
}

r.section('14. A session cannot outlive its task');
{
  await run(`
    await f.reset();
    const id = await f.db.tasks.add(f.T({ title: 'Vanishing act', priority: 1, estimateMin: 15 }));
    return id;
  `);
  await t.send('Page.navigate', { url: t.url });
  await wait(2600);
  await install();
  await click('Start', 'main');
  await wait(500);
  r.ok('the session is running', (await js(`!!document.querySelector('[data-session]')`)) === true);

  // Simulates the task being completed in another tab or pulled as done by a
  // sync: a clock left ticking against nothing is unrecoverable from the UI,
  // because the UI it would need is the one it is covering up.
  await run(`
    const task = await f.byTitle('Vanishing act');
    await f.db.tasks.put({ ...task, status: 'done', completedAt: Date.now() });
    return 'done elsewhere';
  `);
  await wait(900);
  const v = await js(`(() => ({
    session: !!document.querySelector('[data-session]'),
    stored: localStorage.getItem('pp.session.v1'),
    nav: document.querySelectorAll('nav button').length,
  }))()`);
  eq('finishing it elsewhere closes the session', v.session, false);
  eq('the stored session is cleared too', v.stored, null);
  r.ok('and the board is usable again', v.nav > 0, String(v.nav));
}

r.section('15. Leaving banks the time');
{
  await run(`
    await f.reset();
    await f.db.tasks.add(f.T({ title: 'Tidy the desk', priority: 1, estimateMin: 15 }));
    return 'seeded';
  `);
  await t.send('Page.navigate', { url: t.url });
  await wait(2600);
  await install();
  await click('Start', 'main');
  await wait(500);
  await run(`f.ageBy(7 * 60_000); return 'aged'`);
  await t.send('Page.navigate', { url: t.url });
  await wait(2600);
  await install();
  await click('Leave session', '[data-session]');
  await wait(700);

  const v = await run(`
    const task = await f.byTitle('Tidy the desk');
    return { spent: task.spentMin ?? 0, status: task.status, stored: f.stored(),
      steps: document.body.innerText };
  `);
  eq('the time is recorded', v.spent, 7);
  eq('the task is untouched otherwise', v.status, 'todo');
  eq('and the session is over', v.stored, null);
}

r.section('16. The board shows a checklist exists');
{
  await run(`
    await f.reset();
    await f.db.tasks.add(f.T({ title: 'Pack for the trip', priority: 2, estimateMin: 30,
      checklist: [{ id: 'a', text: 'Passport', done: true }, { id: 'b', text: 'Charger', done: false },
        { id: 'c', text: 'Tickets', done: false }] }));
    return 'seeded';
  `);
  await t.send('Page.navigate', { url: t.url });
  await wait(2600);
  await install();

  const v = await js(`(() => {
    const el = document.querySelector('[data-task-steps]');
    return { attr: el?.getAttribute('data-task-steps') ?? null, text: el?.innerText.trim() ?? null };
  })()`);
  eq('the row carries the progress', v.attr, '1/3');
  eq('and says what it is', v.text, '1/3 steps');
}

r.section('17. Starting from a row, not just the recommendation');
{
  await run(`
    await f.reset();
    const project = await f.db.projects.add({ name: 'Move', domain: 'work', color: '#888',
      createdAt: Date.now(), updatedAt: Date.now(), archived: 0 });
    const blocker = await f.db.tasks.add(f.T({ title: 'Get the quote', priority: 1, estimateMin: 30 }));
    await f.db.tasks.add(f.T({ title: 'Write the rollback plan', priority: 1, estimateMin: 45,
      focusLevel: 'deep', projectId: project }));
    await f.db.tasks.add(f.T({ title: 'Book the van', priority: 2, estimateMin: 20,
      projectId: project, blockedBy: blocker }));
    await f.db.tasks.add(f.T({ title: 'Already handled', priority: 2, estimateMin: 20,
      status: 'done', completedAt: Date.now(), projectId: project }));
    localStorage.setItem('pp.context.v1', JSON.stringify(
      { availableMin: 120, focus: 'deep', domain: 'work', projectId: 'all', context: 'any' }));
    return 'seeded';
  `);
  await t.send('Page.navigate', { url: t.url });
  await wait(2600);
  await install();

  // A ranked alternative is a real recommendation the user preferred; it has to
  // be startable without first making it the top pick. The top card carries its
  // own big Start button, so a row-level one only ever belongs to an alternative.
  const picked = await js(`(() => {
    const rows = [...document.querySelectorAll('main [data-task-title]')]
      .filter(el => el.querySelector('[data-start-task]'));
    if (!rows.length) throw new Error('no Start on any alternative row');
    const title = rows[0].getAttribute('data-task-title');
    rows[0].querySelector('[data-start-task]').click();
    return title;
  })()`);
  await wait(700);
  const started = await js(
    `document.querySelector('[data-session-task]')?.getAttribute('data-session-task') ?? null`);
  eq('an alternative starts the task it belongs to', started, picked);

  await click('Leave session', '[data-session]');
  await wait(700);

  // The Tasks tab and the project drawer are the other two places a task is
  // shown, and a row that offers Start in one place must offer it in all.
  const tab = (name) => js(`(() => {
    const b = [...document.querySelectorAll('nav button')]
      .find(x => x.innerText.trim() === ${JSON.stringify(name)});
    if (!b) throw new Error('no tab ' + ${JSON.stringify(name)}); b.click(); return 'ok';
  })()`);

  await tab('Tasks');
  await wait(700);
  const rows = await js(`(() => {
    const out = {};
    for (const el of document.querySelectorAll('[data-task-title]'))
      out[el.getAttribute('data-task-title')] = !!el.querySelector('[data-start-task]');
    return out;
  })()`);
  eq('an open task on the Tasks tab offers Start', rows['Write the rollback plan'], true);
  // Starting a blocked task would contradict the session screen, which ends a
  // session the moment its task is marked blocked.
  eq('a blocked one does not', rows['Book the van'], false);

  await js(`(() => {
    const row = document.querySelector('[data-task-title="Write the rollback plan"]');
    row.querySelector('[data-start-task]').click(); return 'ok';
  })()`);
  await wait(700);
  const v = await js(`(() => ({
    task: document.querySelector('[data-session-task]')?.getAttribute('data-session-task') ?? null,
    nav: document.querySelectorAll('nav button').length,
  }))()`);
  eq('the Tasks tab starts a session too', v.task, 'Write the rollback plan');
  eq('and it takes over the whole screen', v.nav, 0);

  await click('Leave session', '[data-session]');
  await wait(700);

  await tab('Tasks');
  await wait(600);
  await js(`(() => {
    const sel = [...document.querySelectorAll('select')]
      .find(s => [...s.options].some(o => o.value === 'done' && o.text === 'Done'));
    if (!sel) throw new Error('no status filter');
    const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    set.call(sel, 'done');
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  await wait(600);
  const offered = await js(`(() => {
    const el = document.querySelector('[data-task-title="Already handled"]');
    if (!el) throw new Error('the done filter shows no completed task');
    return !!el.querySelector('[data-start-task]');
  })()`);
  eq('a completed task never offers Start', offered, false);

  await tab('Projects');
  await wait(700);
  const inProject = await js(`(() => {
    const head = [...document.querySelectorAll('button')].find(x => x.innerText.includes('Move'));
    if (head) head.click();
    return 'ok';
  })()`);
  eq('the project drawer opens', inProject, 'ok');
  await wait(700);
  const projStart = await js(`(() => {
    const el = document.querySelector('[data-task-title="Write the rollback plan"]');
    if (!el) return null;
    const b = el.querySelector('[data-start-task]');
    if (!b) return false;
    b.click(); return true;
  })()`);
  eq('a task inside a project offers Start', projStart, true);
  await wait(700);
  eq('and starting it works from there', await js(
    `document.querySelector('[data-session-task]')?.getAttribute('data-session-task') ?? null`),
    'Write the rollback plan');
}

process.exit(r.done(t.errors) ? 0 : 1);
