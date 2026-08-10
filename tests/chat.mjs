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

const type = (selector, value) => js(`(()=>{
  const i = document.querySelector(${JSON.stringify(selector)});
  if (!i) throw new Error('no input: ' + ${JSON.stringify(selector)});
  const proto = i.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto,'value').set.call(i, ${JSON.stringify(value)});
  i.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';
})()`);

// Deterministic fixture. Earlier suites leave the database in their own state.
await js(`(async () => {
  const { db } = window.__fb;
  await db.tasks.clear(); await db.projects.clear();
  await db.tombstones.clear(); await db.syncState.clear(); await db.syncLinks.clear();
  const now = Date.now();
  const site = await db.projects.add({ name:'Website', domain:'work', color:'#6366f1',
    archived:0, createdAt:now, updatedAt:now });
  const home = await db.projects.add({ name:'Home', domain:'personal', color:'#22c55e',
    archived:0, createdAt:now, updatedAt:now });
  const T = (title, extra) => db.tasks.add({ title, notes:'', domain:'work', priority:3,
    estimateMin:30, focusLevel:'medium', status:'todo', tags:[], createdAt:now, updatedAt:now, ...extra });
  await T('Rewrite the landing copy', { projectId: site, priority:1, estimateMin:90, focusLevel:'deep' });
  await T('Reply to Dana',            { priority:2, estimateMin:10, focusLevel:'shallow' });
  await T('Fix the footer links',     { projectId: site, priority:4, estimateMin:20, focusLevel:'shallow' });
  await T('Book the dentist',         { domain:'personal', projectId: home, priority:2, estimateMin:15, focusLevel:'shallow' });
  await T('Old finished thing',       { status:'done', completedAt: now });
  // Dexie keeps its autoincrement counter across clear(), so ids are not 1..n.
  window.__ids = { site, home };
  return 'seeded';
})()`);
const SITE = await js(`window.__ids.site`);
await t.send('Page.navigate', { url: t.url });
await wait(2500);

// Tools are exercised directly here; the conversation loop is driven through
// the UI further down. Splitting them keeps a tool bug from looking like a
// loop bug.
const ctxRef = `{ getContext: () => ({ availableMin: 60, focus: 'medium', domain: 'work', projectId: 'all' }), setContext: (p) => { window.__ctxPatch = p; } }`;
const run = (name, input) =>
  js(`window.__fb.chatTools.executeTool(${JSON.stringify(name)}, ${JSON.stringify(input)}, ${ctxRef})`);

r.section('1. Reading the board');
const todo = await run('list_tasks', {});
eq('lists only open tasks by default', todo.count, 4);
eq('includes the project name', todo.tasks.find((x) => x.title === 'Rewrite the landing copy').project, 'Website');
eq('reports priority readably', todo.tasks.find((x) => x.title === 'Reply to Dana').priority, 'P2');
eq('filters by area', (await run('list_tasks', { area: 'personal' })).count, 1);
eq('filters by status', (await run('list_tasks', { status: 'done' })).count, 1);
eq('searches titles', (await run('list_tasks', { search: 'dentist' })).tasks.length, 1);
eq('search is case-insensitive', (await run('list_tasks', { search: 'DANA' })).tasks.length, 1);
eq('lists projects with open counts',
  (await run('list_projects', {})).projects.map((p) => [p.name, p.area, p.openTasks]),
  [['Website', 'work', 2], ['Home', 'personal', 1]]);

r.section('2. recommend defers to the real scoring engine');
const rec = await run('recommend', { availableMin: 15, focus: 'shallow' });
eq('echoes the context it used', [rec.context.availableMin, rec.context.focus], [15, 'shallow']);
eq('ranks a short shallow task first', rec.top[0].title, 'Reply to Dana');
eq('carries the explanation', rec.top[0].why.length > 0, true);
eq('stays inside the work area', rec.top.every((x) => x.area === 'work'), true);
eq('session plan fits the window', rec.sessionPlan.usedMin <= 15, true);
// The whole point of the tool: identical to what the Focus tab would show.
eq('matches the recommender exactly', await js(`(async () => {
  const { db } = window.__fb;
  const tasks = await db.tasks.toArray();
  const mod = await import('/src/recommender.ts');
  const scored = mod.recommend(tasks, { availableMin:15, focus:'shallow', domain:'work', projectId:'all' });
  return scored.slice(0,5).map(s => s.task.title);
})()`), rec.top.map((x) => x.title));

r.section('3. Creating tasks');
const made = await run('create_task', { title: 'Draft the retro notes', estimateMin: 25, focus: 'deep', priority: 2 });
eq('returns what it created', [made.created.title, made.created.estimateMin, made.created.focus], ['Draft the retro notes', 25, 'deep']);
eq('inherits the context area', made.created.area, 'work');
eq('defaults are applied', (await run('create_task', { title: 'Bare minimum' })).created.estimateMin, 30);
eq('default priority is P3', (await run('list_tasks', { search: 'Bare minimum' })).tasks[0].priority, 'P3');
const inProject = await run('create_task', { title: 'Compress the hero image', projectId: SITE, area: 'personal' });
eq('a project overrides a contradictory area', inProject.created.area, 'work');
eq('and files it in the project', inProject.created.project, 'Website');
eq('rejects an unknown project', await run('create_task', { title: 'Nope', projectId: 999 }).catch((e) => String(e).includes('999')), true);

r.section('4. Updating and completing');
const target = (await run('list_tasks', { search: 'Book the dentist' })).tasks[0].id;
const upd = await run('update_task', { id: target, priority: 1, estimateMin: 45 });
eq('applies only what was passed', [upd.updated.priority, upd.updated.estimateMin], ['P1', 45]);
eq('leaves other fields alone', upd.updated.title, 'Book the dentist');
eq('moving to a project adopts its area',
  (await run('update_task', { id: target, projectId: SITE })).updated.area, 'work');
eq('projectId 0 detaches it', (await run('update_task', { id: target, projectId: 0 })).updated.project, undefined);
const done = await run('complete_task', { id: target });
eq('completes', done.updated.status, 'done');
eq('and reopens', (await run('complete_task', { id: target, done: false })).updated.status, 'todo');
eq('reopening clears the completion stamp', await js(`window.__fb.db.tasks.get(${target}).then(t => t.completedAt === undefined)`), true);
eq('rejects an unknown task', await run('update_task', { id: 4242 }).catch((e) => String(e).includes('4242')), true);

r.section('5. Projects and context');
const proj = await run('create_project', { name: 'Garden', area: 'personal' });
eq('creates a project', [proj.created.name, proj.created.area], ['Garden', 'personal']);
eq('it is visible immediately', (await run('list_projects', {})).projects.some((p) => p.name === 'Garden'), true);
eq('requires an area', await run('create_project', { name: 'Vague' }).catch((e) => String(e).includes('area')), true);
await run('set_context', { availableMin: 20, focus: 'shallow' });
eq('context changes are handed to the app', await js(`window.__ctxPatch`), { availableMin: 20, focus: 'shallow' });
eq('an unknown tool is refused', await run('nonexistent', {}).catch((e) => String(e).includes('nonexistent')), true);

r.section('6. No tool can delete anything');
eq('there is no delete tool', await js(`window.__fb.chatTools.TOOL_SCHEMAS.some(s => /delete|remove|destroy/i.test(s.name))`), false);
eq('the model is told so', await js(`(async () => {
  const src = await fetch('/src/chat/useChat.ts').then(r => r.text());
  return /cannot delete anything/i.test(src);
})()`), true);

r.section('7. The key gate');
await js(`window.__fb.chatKey.clearApiKey(); 'x'`);
await t.send('Page.navigate', { url: t.url });
await wait(2000);
await click('jAIme'); await wait(400);
eq('asks for a key first', await js(`document.body.innerText.toUpperCase().includes('CONNECT JAIME')`), true);
eq('no message box until connected', await js(`!document.querySelector('[aria-label="Message jAIme"]')`), true);
await type('input[aria-label="Anthropic API key"]', 'not-a-real-key');
await wait(200);
eq('warns about an odd-looking key', await js(`document.body.innerText.includes('normally start with')`), true);
await type('input[aria-label="Anthropic API key"]', 'sk-ant-test123');
await wait(200);
eq('warning clears for a plausible key', await js(`document.body.innerText.includes('normally start with')`), false);
eq('memory-only is the default', await js(`document.querySelector('input[type=checkbox]').checked`), false);
await click('Save key'); await wait(400);
eq('the chat opens once connected', await js(`!!document.querySelector('[aria-label="Message jAIme"]')`), true);
eq('the key was not written to disk', await js(`localStorage.getItem('pp.claude.apiKey')`), null);

r.section('8. A conversation that uses tools');
await js(`(() => {
  const F = window.__fb.FakeClaudeTransport;
  const fake = new F();
  fake.callTool('recommend', { availableMin: 15, focus: 'shallow' });
  fake.say('Reply to Dana — ten minutes and barely any thought.');
  window.__fbChatTransport = fake;
  return 'installed';
})()`);
// Re-render so App picks the transport up.
await click('Focus'); await wait(200); await click('jAIme'); await wait(300);
await type('[aria-label="Message jAIme"]', 'what should I work on?');
await wait(150);
await click('Send');
await wait(900);
eq('the question is shown', await js(`document.body.innerText.includes('what should I work on?')`), true);
eq('tool use is visible to the user', await js(`document.body.innerText.includes('Asked the scoring engine')`), true);
eq('the answer is rendered', await js(`document.body.innerText.includes('Reply to Dana — ten minutes')`), true);
eq('the model was given the tools', await js(`(() => {
  const names = window.__fbChatTransport.requests[0].tools.map(t => t.name).sort();
  return names.join(',');
})()`), 'complete_task,create_project,create_task,list_projects,list_tasks,recommend,set_context,update_task');
eq('the tool result was fed back', await js(`(() => {
  const results = window.__fbChatTransport.lastToolResults();
  return results.length === 1 && JSON.parse(results[0].content).top[0].title;
})()`), 'Reply to Dana');

r.section('9. Tools that change the board really change it');
await js(`(() => {
  const fake = new window.__fb.FakeClaudeTransport();
  fake.callTool('create_task', { title: 'Water the plants', area: 'personal', estimateMin: 5, focus: 'shallow' });
  fake.say('Added it.');
  window.__fbChatTransport = fake;
  return 'ok';
})()`);
await click('Focus'); await wait(200); await click('jAIme'); await wait(300);
await type('[aria-label="Message jAIme"]', 'remind me to water the plants');
await wait(150);
await click('Send');
await wait(900);
eq('the action is narrated', await js(`document.body.innerText.includes('Added "Water the plants"')`), true);
eq('and it landed in the database', await js(`(async () => {
  const rows = await window.__fb.db.tasks.toArray();
  const made = rows.find(t => t.title === 'Water the plants');
  return made ? [made.domain, made.estimateMin, made.focusLevel] : null;
})()`), ['personal', 5, 'shallow']);

r.section('10. A failing tool is recovered from, not fatal');
await js(`(() => {
  const fake = new window.__fb.FakeClaudeTransport();
  fake.callTool('complete_task', { id: 99999 });
  fake.callTool('list_tasks', { search: 'dentist' });
  fake.say('Done — I had to look it up first.');
  window.__fbChatTransport = fake;
  return 'ok';
})()`);
await click('Focus'); await wait(200); await click('jAIme'); await wait(300);
await type('[aria-label="Message jAIme"]', 'finish the dentist one');
await wait(150);
await click('Send');
await wait(1200);
eq('the failure is surfaced', await js(`document.body.innerText.includes('No task with id 99999')`), true);
eq('the model got the error and retried', await js(`document.body.innerText.includes('Read your tasks')`), true);
eq('the conversation still finished', await js(`document.body.innerText.includes('I had to look it up first')`), true);

r.section('11. Transport errors surface without breaking the panel');
await js(`(() => {
  const fake = new window.__fb.FakeClaudeTransport();
  fake.failWith = 'That API key was rejected. Check it and try again.';
  window.__fbChatTransport = fake;
  return 'ok';
})()`);
await click('Focus'); await wait(200); await click('jAIme'); await wait(300);
await type('[aria-label="Message jAIme"]', 'hello');
await wait(150);
await click('Send');
await wait(700);
eq('the error is shown plainly', await js(`document.body.innerText.includes('That API key was rejected')`), true);
eq('the input is usable again', await js(`!document.querySelector('[aria-label="Message jAIme"]').disabled`), true);

const passed = r.done(t.errors);
t.close();
process.exit(passed ? 0 : 1);
