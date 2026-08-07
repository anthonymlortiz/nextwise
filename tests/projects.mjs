import { connect, reporter } from './lib.mjs';

const t = await connect();
const r = reporter();
const js = t.js;
const wait = (ms) => new Promise((z) => setTimeout(z, ms));
const eq = (n, a, e) =>
  r.ok(n, JSON.stringify(a) === JSON.stringify(e), `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);

const click = (label) => js(`(()=>{
  const el = [...document.querySelectorAll('button')].find(b => b.innerText.trim().toLowerCase() === ${'`'}\${${JSON.stringify(label)}}${'`'}.toLowerCase());
  if (!el) throw new Error('no button: ' + ${JSON.stringify(label)});
  el.click(); return 'ok';
})()`);

// Deterministic fixture: earlier suites mutate the database, so build our own.
await js(`(async () => {
  const { db } = window.__fb;
  await db.tasks.clear(); await db.projects.clear();
  await db.tombstones.clear(); await db.syncState.clear();
  const now = Date.now();
  const P = (name, domain) => db.projects.add({ name, domain, color:'#6366f1', archived:0, createdAt:now, updatedAt:now });
  const alpha = await P('Alpha', 'work');
  const beta  = await P('Beta', 'work');
  const casa  = await P('Casa', 'personal');
  const T = (title, extra) => db.tasks.add({ title, notes:'', domain:'work', priority:3, estimateMin:30,
    focusLevel:'medium', status:'todo', tags:[], createdAt:now, updatedAt:now, ...extra });
  await T('Alpha one',  { projectId: alpha, priority: 1 });
  await T('Alpha two',  { projectId: alpha, priority: 2 });
  await T('Alpha done', { projectId: alpha, status:'done', completedAt: now });
  await T('Casa chore', { projectId: casa, domain:'personal' });
  await T('Loose end',  {});
  return 'seeded';
})()`);
await t.send('Page.navigate', { url: t.url });
await wait(2500);

const header = (name) => `[...document.querySelectorAll('button[aria-expanded]')].find(b=>b.innerText.includes(${JSON.stringify(name)}))`;
const expandedTitles = () => js(`(()=>{
  const hdr = document.querySelector('button[aria-expanded="true"]');
  if (!hdr) return [];
  const body = hdr.closest('.group').lastElementChild;
  return [...body.querySelectorAll('button')]
    .filter(b => b.innerText.trim() === 'Edit')
    .map(b => b.closest('.group').innerText.split('\\n')[0]);
})()`);
const statsFor = (name) => js(`${header(name)}.innerText.split('\\n').pop()`);

await click('Projects');
await wait(300);

r.section('1. Projects start collapsed');
eq('all projects listed', await js(`[...document.querySelectorAll('button[aria-expanded]')].map(b=>b.innerText.split('\\n')[0])`), ['Alpha', 'Beta', 'Casa']);
eq('nothing expanded yet', await js(`!!document.querySelector('button[aria-expanded="true"]')`), false);
eq('no task rows visible', await expandedTitles(), []);
eq('summary still shown', await statsFor('Alpha'), '2 open · 1 done · 1h remaining');

r.section('2. Expanding a project reveals its tasks');
await js(`${header('Alpha')}.click(); 'ok'`);
await wait(250);
eq('aria-expanded flips', await js(`${header('Alpha')}.getAttribute('aria-expanded')`), 'true');
eq('shows only open Alpha tasks, priority order', await expandedTitles(), ['Alpha one', 'Alpha two']);
eq('other projects tasks excluded', await js(`document.body.innerText.includes('Casa chore')`), false);
eq('project-less task excluded', await js(`document.body.innerText.includes('Loose end')`), false);

r.section('3. Completed tasks are opt-in');
eq('done task hidden by default', await js(`document.body.innerText.includes('Alpha done')`), false);
await js(`document.querySelector('input[type=checkbox]').click(); 'ok'`);
await wait(250);
eq('done task revealed', await expandedTitles(), ['Alpha one', 'Alpha two', 'Alpha done']);
await js(`document.querySelector('input[type=checkbox]').click(); 'ok'`);
await wait(250);
eq('toggles back off', await expandedTitles(), ['Alpha one', 'Alpha two']);

r.section('4. Only one project opens at a time');
await js(`${header('Casa')}.click(); 'ok'`);
await wait(250);
eq('Casa now open', await expandedTitles(), ['Casa chore']);
eq('Alpha collapsed', await js(`${header('Alpha')}.getAttribute('aria-expanded')`), 'false');
eq('exactly one expanded', await js(`document.querySelectorAll('button[aria-expanded="true"]').length`), 1);

r.section('5. Empty project explains itself');
await js(`${header('Beta')}.click(); 'ok'`);
await wait(250);
eq('no rows', await expandedTitles(), []);
eq('empty message', await js(`document.body.innerText.includes('No tasks in this project yet')`), true);

r.section('6. Completing a task from the project view updates the summary');
await js(`${header('Alpha')}.click(); 'ok'`);
await wait(250);
await js(`(()=>{
  const hdr = document.querySelector('button[aria-expanded="true"]');
  const body = hdr.closest('.group').lastElementChild;
  const row = [...body.querySelectorAll('button')].find(b=>b.innerText.trim()==='Edit').closest('.group');
  row.querySelector('button[aria-label="Mark as done"]').click();
  return 'ok';
})()`);
await wait(400);
eq('task leaves the open list', await expandedTitles(), ['Alpha two']);
eq('summary recalculated', await statsFor('Alpha'), '1 open · 2 done · 30m remaining');
eq('still expanded after the update', await js(`${header('Alpha')}.getAttribute('aria-expanded')`), 'true');

r.section('7. Adding a task from a project pre-selects it');
await click('+ Add task');
await wait(300);
eq('form opened', await js(`!!document.querySelector('input[placeholder="What needs doing?"]')`), true);
eq('project pre-filled', await js(`(()=>{
  const form = document.querySelector('input[placeholder="What needs doing?"]').closest('form');
  const sel = [...form.querySelectorAll('select')].find(s => [...s.options].some(o => o.text === 'Alpha'));
  return sel.options[sel.selectedIndex].text;
})()`), 'Alpha');
eq('area pre-filled from project', await js(`(()=>{
  const form = document.querySelector('input[placeholder="What needs doing?"]').closest('form');
  const sel = [...form.querySelectorAll('select')].find(s => [...s.options].some(o => o.text === 'Personal'));
  return sel.options[sel.selectedIndex].text;
})()`), 'Work');
await js(`(()=>{
  const i = document.querySelector('input[placeholder="What needs doing?"]');
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(i, 'Made from project');
  i.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';
})()`);
await wait(120);
await click('Add task');
await wait(400);
eq('new task landed in the project', await expandedTitles(), ['Alpha two', 'Made from project']);

r.section('8. A plain new task is not pre-assigned');
await click('+ New task');
await wait(300);
eq('project field cleared again', await js(`(()=>{
  const form = document.querySelector('input[placeholder="What needs doing?"]').closest('form');
  const sel = [...form.querySelectorAll('select')].find(s => [...s.options].some(o => o.text === 'Alpha'));
  return sel.options[sel.selectedIndex].text;
})()`), 'No project');
await click('Cancel');
await wait(250);

r.section('9. View in Tasks deep-links the filter');
await click('View in Tasks');
await wait(400);
eq('switched to the Tasks tab', await js(`document.body.innerText.includes('ALL TASKS')`), true);
eq('project filter applied', await js(`(()=>{
  const sel = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.text === 'Alpha'));
  return sel.options[sel.selectedIndex].text;
})()`), 'Alpha');
eq('only that project is listed', await js(`[...document.querySelectorAll('button')]
  .filter(b=>b.innerText.trim()==='Edit')
  .map(b=>b.closest('.group').innerText.split('\\n')[0])`), ['Alpha two', 'Made from project']);

r.section('10. Editing a project: rename, recolour, and change area');
await click('Projects');
await wait(400);
const before = await js(`(async () => {
  const { db } = window.__fb;
  const p = (await db.projects.toArray()).find(x => x.name === 'Alpha');
  const ts = await db.tasks.where('projectId').equals(p.id).toArray();
  return { domain: p.domain, taskDomains: ts.map(t => t.domain), count: ts.length };
})()`);
eq('Alpha starts as work', before.domain, 'work');
eq('and so do its tasks', before.taskDomains.every((d) => d === 'work'), true);

// Open the row's editor. Buttons are hover-revealed but still clickable.
await js(`(()=>{
  const row = ${header('Alpha')}.closest('.group');
  const btn = [...row.querySelectorAll('button')].find(b => b.innerText.trim() === 'Edit');
  if (!btn) throw new Error('no Edit button');
  btn.click(); return 'ok';
})()`);
await wait(300);
eq('the editor is prefilled', await js(`(()=>{
  const f = document.querySelector('form input[aria-label="Project name"]');
  const sel = f.closest('form').querySelector('select[aria-label="Project area"]');
  return [f.value, sel.options[sel.selectedIndex].text];
})()`), ['Alpha', 'Work']);

await js(`(()=>{
  const input = document.querySelector('form input[aria-label="Project name"]');
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(input, 'Alpha Renamed');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const sel = input.closest('form').querySelector('select[aria-label="Project area"]');
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set.call(sel, 'personal');
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return 'ok';
})()`);
await wait(250);
eq('it warns that the tasks come along', await js(`(()=>{
  const f = document.querySelector('form input[aria-label="Project name"]').closest('form');
  return /task[s]? move to personal too/.test(f.innerText);
})()`), true);

await click('Save');
await wait(500);

const after = await js(`(async () => {
  const { db } = window.__fb;
  const all = await db.projects.toArray();
  const p = all.find(x => x.name === 'Alpha Renamed');
  const ts = await db.tasks.where('projectId').equals(p.id).toArray();
  const loose = (await db.tasks.toArray()).find(t => t.title === 'Loose end');
  return { renamed: !!p, stale: all.some(x => x.name === 'Alpha'), domain: p.domain,
    moved: ts.every(t => t.domain === 'personal'), count: ts.length, loose: loose.domain };
})()`);
eq('the project was renamed', after.renamed, true);
eq('no duplicate left behind', after.stale, false);
eq('area changed to personal', after.domain, 'personal');
eq('its tasks moved with it', after.moved, true);
eq('no tasks lost', after.count, before.count);
eq('unrelated task untouched', after.loose, 'work');
eq('it now renders under Personal', await js(`(()=>{
  const heads = [...document.querySelectorAll('*')].filter(e => !e.children.length && e.innerText === 'Personal');
  const section = heads[0]?.closest('div')?.parentElement;
  return !!section && section.innerText.includes('Alpha Renamed');
})()`), true);
eq('the editor closed', await js(`!document.querySelector('input[aria-label="Project name"]')`), true);

r.section('11. Cancel discards edits');
await js(`(()=>{
  const row = ${header('Casa')}.closest('.group');
  [...row.querySelectorAll('button')].find(b => b.innerText.trim() === 'Edit').click(); return 'ok';
})()`);
await wait(300);
await js(`(()=>{
  const input = document.querySelector('form input[aria-label="Project name"]');
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(input, 'Throwaway');
  input.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';
})()`);
await wait(150);
await click('Cancel');
await wait(350);
eq('the name survived', await js(`(async () => {
  const { db } = window.__fb;
  const names = (await db.projects.toArray()).map(p => p.name);
  return [names.includes('Casa'), names.includes('Throwaway')];
})()`), [true, false]);

const passed = r.done(t.errors);
t.close();
process.exit(passed ? 0 : 1);
