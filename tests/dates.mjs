import { connect, reporter } from './lib.mjs';

const t = await connect();
const r = reporter();
const js = t.js;
const wait = (ms) => new Promise((z) => setTimeout(z, ms));
const eq = (n, a, e) =>
  r.ok(n, JSON.stringify(a) === JSON.stringify(e), `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);

const click = (label) => js(`(()=>{
  const el = [...document.querySelectorAll('button')].find(b => b.innerText.trim().toLowerCase() === ${JSON.stringify(label)}.toLowerCase());
  if (!el) throw new Error('no button: ' + ${JSON.stringify(label)});
  el.click(); return 'ok';
})()`);

const D = (expr) => js(`import('/src/dates.ts').then(m => (${expr}))`);
const triggerText = () => js(`document.querySelector('button[aria-haspopup=dialog]').innerText.trim()`);
const openPicker = () => js(`document.querySelector('button[aria-haspopup=dialog]').click(); 'ok'`);
const dialogButton = (label) => js(`(()=>{
  const d = document.querySelector('[role=dialog][aria-label="Choose a due date"]');
  if (!d) throw new Error('calendar is not open');
  const b = [...d.querySelectorAll('button')].find(x => x.innerText.trim() === ${JSON.stringify(label)});
  if (!b) throw new Error('no calendar button: ' + ${JSON.stringify(label)});
  b.click(); return 'ok';
})()`);

await js(`(async () => {
  const { db } = window.__fb;
  await db.tasks.clear(); await db.projects.clear();
  const now = Date.now();
  await db.tasks.add({ title:'Datable task', notes:'', domain:'work', priority:3, estimateMin:30,
    focusLevel:'medium', status:'todo', tags:[], createdAt:now, updatedAt:now });
  return 'seeded';
})()`);
await t.send('Page.navigate', { url: t.url });
await wait(2500);

r.section('1. Dates are handled in local time, never UTC');
// The bug this guards against: toISOString() converts to UTC first, so an
// evening date west of Greenwich comes back as the previous day.
eq('formats a local date correctly', await D(`m.toISODate(new Date(2026, 2, 8, 23, 30))`), '2026-03-08');
eq('late evening does not roll forward', await D(`m.toISODate(new Date(2026, 0, 1, 23, 59))`), '2026-01-01');
eq('early morning does not roll back', await D(`m.toISODate(new Date(2026, 0, 1, 0, 1))`), '2026-01-01');
eq('round-trips through parse', await D(`m.toISODate(m.fromISODate('2026-11-30'))`), '2026-11-30');
eq('parses to local midnight', await D(`m.fromISODate('2026-06-15').getHours()`), 0);
eq('pads single digits', await D(`m.toISODate(new Date(2026, 0, 5))`), '2026-01-05');

r.section('2. Arithmetic survives DST and month ends');
// US DST forward is 8 Mar 2026; that day is 23 hours long, so millisecond
// arithmetic would land on the wrong date.
eq('crossing spring forward', await D(`m.addDays('2026-03-07', 1)`), '2026-03-08');
eq('spanning the DST week', await D(`m.addDays('2026-03-05', 7)`), '2026-03-12');
eq('crossing autumn back', await D(`m.addDays('2026-10-31', 2)`), '2026-11-02');
eq('crossing a year boundary', await D(`m.addDays('2026-12-31', 1)`), '2027-01-01');
eq('going backwards', await D(`m.addDays('2026-01-01', -1)`), '2025-12-31');
eq('leap day exists in 2028', await D(`m.addDays('2028-02-28', 1)`), '2028-02-29');
eq('and not in 2026', await D(`m.addDays('2026-02-28', 1)`), '2026-03-01');
eq('month add clamps to the shorter month', await D(`m.addMonths('2026-01-31', 1)`), '2026-02-28');
eq('month add clamps into a leap February', await D(`m.addMonths('2028-01-31', 1)`), '2028-02-29');
eq('month subtract crosses the year', await D(`m.addMonths('2026-01-15', -1)`), '2025-12-15');
eq('a normal month add is untouched', await D(`m.addMonths('2026-05-10', 1)`), '2026-06-10');

r.section('3. Weekday and relative helpers');
// 2026-07-31 is a Friday.
eq('next Monday from a Friday', await D(`m.nextWeekday(1, new Date(2026, 6, 31))`), '2026-08-03');
eq('next Saturday from a Friday', await D(`m.nextWeekday(6, new Date(2026, 6, 31))`), '2026-08-01');
eq('asking for today jumps a full week', await D(`m.nextWeekday(5, new Date(2026, 6, 31))`), '2026-08-07');
eq('today', await D(`m.relativeLabel('2026-07-31', new Date(2026, 6, 31))`), 'today');
eq('tomorrow', await D(`m.relativeLabel('2026-08-01', new Date(2026, 6, 31))`), 'tomorrow');
eq('yesterday', await D(`m.relativeLabel('2026-07-30', new Date(2026, 6, 31))`), 'yesterday');
eq('overdue counts up', await D(`m.relativeLabel('2026-07-25', new Date(2026, 6, 31))`), '6 days overdue');
eq('a few days out', await D(`m.relativeLabel('2026-08-03', new Date(2026, 6, 31))`), 'in 3 days');
eq('relative label ignores time of day', await D(`m.relativeLabel('2026-07-31', new Date(2026, 6, 31, 23, 59))`), 'today');
eq('formats readably', await D(`m.formatDate('2026-08-03', new Date(2026, 6, 31))`), 'Mon 3 Aug');
eq('shows the year when it differs', await D(`m.formatDate('2027-01-04', new Date(2026, 6, 31))`), 'Mon 4 Jan 2027');
eq('rejects a malformed date', await D(`m.isValidISODate('2026-13-01')`), false);
eq('rejects an impossible day', await D(`m.isValidISODate('2026-02-30')`), false);
eq('accepts a real one', await D(`m.isValidISODate('2026-02-28')`), true);

r.section('4. The month grid');
const grid = await D(`m.monthGrid(2026, 7)`);
eq('always six rows', grid.length, 6);
eq('seven columns', grid.every((w) => w.length === 7), true);
eq('starts on a Sunday', await D(`m.fromISODate(m.monthGrid(2026, 7)[0][0]).getDay()`), 0);
eq('contains every day of the month', grid.flat().filter((d) => d.startsWith('2026-08')).length, 31);
eq('leads with the previous month', grid[0][0], '2026-07-26');
eq('days run consecutively', await D(`(() => {
  const flat = m.monthGrid(2026, 7).flat();
  return flat.every((d, i) => i === 0 || d === m.addDays(flat[i-1], 1));
})()`), true);
eq('February in a leap year still fills six rows', await D(`m.monthGrid(2028, 1).length`), 6);

r.section('5. The picker opens and shows shortcuts');
await click('Tasks'); await wait(300);
await click('+ New task'); await wait(400);
eq('shows no date initially', await js(`document.body.innerText.includes('No due date')`), true);
eq('the calendar is closed', await js(`!document.querySelector('[role=dialog][aria-label="Choose a due date"]')`), true);
await click('No due date'); await wait(300);
eq('the calendar opens', await js(`!!document.querySelector('[role=dialog][aria-label="Choose a due date"]')`), true);
eq('quick picks are offered', await js(`(()=>{
  const d = document.querySelector('[role=dialog][aria-label="Choose a due date"]');
  return ['Today','Tomorrow','This weekend','Next Monday','In a week']
    .every(l => [...d.querySelectorAll('button')].some(b => b.innerText.trim() === l));
})()`), true);
eq('the current month is shown', await js(`(()=>{
  const d = document.querySelector('[role=dialog][aria-label="Choose a due date"]');
  const now = new Date();
  const names = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return d.innerText.includes(names[now.getMonth()] + ' ' + now.getFullYear());
})()`), true);
eq('today is marked', await js(`(()=>{
  const d = document.querySelector('[role=dialog][aria-label="Choose a due date"]');
  return !!d.querySelector('button[aria-current="date"]');
})()`), true);
eq('no clear button until a date is set', await js(`(()=>{
  const d = document.querySelector('[role=dialog][aria-label="Choose a due date"]');
  return [...d.querySelectorAll('button')].some(b => b.innerText.trim() === 'Clear due date');
})()`), false);

r.section('6. Picking a date');
await dialogButton('Tomorrow');
await wait(300);
eq('the calendar closes on choosing', await js(`!document.querySelector('[role=dialog][aria-label="Choose a due date"]')`), true);
eq('the field shows the chosen date', await js(`(async () => {
  const mod = await import('/src/dates.ts');
  const want = mod.formatDate(mod.addDays(mod.todayISO(), 1));
  return document.querySelector('button[aria-haspopup=dialog]').innerText.includes(want);
})()`), true);
eq('and its relative label', (await triggerText()).includes('tomorrow'), true);

r.section('7. Month navigation');
await openPicker();
await wait(300);
const monthShown = () => js(`(()=>{
  const d = document.querySelector('[role=dialog][aria-label="Choose a due date"]');
  return d.querySelector('[data-month-label]').innerText;
})()`);
const startMonth = await monthShown();
await js(`document.querySelector('button[aria-label="Next month"]').click(); 'ok'`);
await wait(250);
const forward = await monthShown();
eq('next month changes the heading', forward !== startMonth, true);
await js(`document.querySelector('button[aria-label="Previous month"]').click(); 'ok'`);
await wait(250);
eq('going back returns to where it was', await monthShown(), startMonth);
eq('the grid keeps six rows while paging', await js(`(()=>{
  const d = document.querySelector('[role=dialog][aria-label="Choose a due date"]');
  return [...d.querySelectorAll('button[aria-label^="20"]')].length;
})()`), 42);

r.section('8. Clearing and persisting');
eq('clear is offered once a date exists', await js(`(()=>{
  const d = document.querySelector('[role=dialog][aria-label="Choose a due date"]');
  return [...d.querySelectorAll('button')].some(b => b.innerText.trim() === 'Clear due date');
})()`), true);
// Pick an explicit day from the grid so the saved value is predictable.
const target = await D(`m.addDays(m.todayISO(), 3)`);
await js(`(()=>{
  const d = document.querySelector('[role=dialog][aria-label="Choose a due date"]');
  const cell = d.querySelector('button[aria-label=' + JSON.stringify(${JSON.stringify(target)}) + ']');
  if (!cell) throw new Error('no cell for ' + ${JSON.stringify(target)});
  cell.click(); return 'ok';
})()`);
await wait(300);
await js(`(()=>{
  const i = document.querySelector('input[placeholder="What needs doing?"]');
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(i, 'Task with a due date');
  i.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';
})()`);
await wait(150);
await click('Add task');
await wait(500);
eq('the picked date is saved verbatim', await js(`(async () => {
  const rows = await window.__fb.db.tasks.toArray();
  return (rows.find(t => t.title === 'Task with a due date') || {}).dueDate;
})()`), target);

r.section('9. Clearing removes the date');
await click('+ New task'); await wait(400);
await openPicker();
await wait(300);
await dialogButton('Today');
await wait(300);
eq('a date is set', (await triggerText()).includes('today'), true);
await openPicker();
await wait(300);
await dialogButton('Clear due date');
await wait(300);
eq('the field is empty again', await triggerText(), 'No due date');

r.section('10. Escape closes without choosing');
await openPicker();
await wait(300);
eq('open before escape', await js(`!!document.querySelector('[role=dialog][aria-label="Choose a due date"]')`), true);
await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 'ok'`);
await wait(300);
eq('closed after escape', await js(`!document.querySelector('[role=dialog][aria-label="Choose a due date"]')`), true);
eq('the task form survives the first escape', await js(`!!document.querySelector('input[placeholder="What needs doing?"]')`), true);
eq('still no date chosen', await triggerText(), 'No due date');
await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 'ok'`);
await wait(300);
eq('a second escape closes the form', await js(`!document.querySelector('input[placeholder="What needs doing?"]')`), true);

const passed = r.done(t.errors);
t.close();
process.exit(passed ? 0 : 1);
