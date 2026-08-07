// Dev-only helper: capture screenshots of each tab so the UI can be reviewed.
// Not part of the test suites — nothing here asserts anything.
//
//   SHOT_DIR=/tmp/shots node tests/shots.mjs
//   SHOT_SCHEME=light SHOT_DIR=/tmp/shots/light node tests/shots.mjs
//
// Expects the test dev server on :5174 and a headless Chrome with CDP on :9225.
import { writeFileSync, mkdirSync } from 'node:fs';

const port = process.env.SHOT_PORT ?? 9225;
const url = process.env.SHOT_URL ?? 'http://localhost:5174/';
const outDir = process.env.SHOT_DIR ?? '/tmp/shots';
const scheme = process.env.SHOT_SCHEME ?? 'dark';
mkdirSync(outDir, { recursive: true });

const targets = await (await fetch(`http://localhost:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('chrome-extension'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (m, p = {}) =>
  new Promise((r) => {
    const i = ++id;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method: m, params: p }));
  });
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result);
    pending.delete(m.id);
  }
};
await new Promise((r) => (ws.onopen = r));
await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: 1000,
  deviceScaleFactor: 2,
  mobile: false,
});
// Headless Chrome defaults to light, so pin the scheme explicitly either way.
await send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-color-scheme', value: scheme }],
});
await send('Page.navigate', { url });
await new Promise((r) => setTimeout(r, 4500));

const js = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
  return r.result.value;
};

// A board with enough variety that the visuals are representative.
await js(`(async () => {
  const { db } = window.__fb;
  await db.tasks.clear(); await db.projects.clear();
  const n = Date.now();
  const p = {};
  for (const [name, domain, color] of [
    ['Platform Migration','work','#6366f1'],
    ['Hiring','work','#f59e0b'],
    ['Health','personal','#10b981'],
    ['Home','personal','#ec4899'],
  ]) p[name] = await db.projects.add({ name, domain, color, createdAt: n });
  const T = (title, domain, projectId, priority, estimateMin, focusLevel, tags, dueOffset, notes='') => ({
    title, notes, domain, projectId, priority, estimateMin, focusLevel,
    status:'todo', tags, createdAt:n, updatedAt:n,
    ...(dueOffset === undefined ? {} : { dueDate: (() => {
      const d = new Date(); d.setDate(d.getDate() + dueOffset);
      return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
    })() }),
  });
  await db.tasks.bulkAdd([
    T('Write the migration rollback plan','work',p['Platform Migration'],1,90,'deep',['writing'],1),
    T('Review shard cutover checklist','work',p['Platform Migration'],2,45,'deep',['review'],3,
      'Runbook: https://wiki.example.com/shard-cutover — ping ops@example.com if step 4 stalls.'),
    T('Reply to candidate scheduling thread','work',p['Hiring'],2,15,'shallow',['admin'],-1),
    T('Draft the senior engineer scorecard','work',p['Hiring'],3,60,'medium',['writing'],5),
    T('Book the annual physical','personal',p['Health'],2,10,'shallow',['calls'],-2),
    T('Plan three gym sessions for next week','personal',p['Health'],3,20,'medium',[],2),
    T('Fix the leaking kitchen tap','personal',p['Home'],2,45,'shallow',['errand'],0),
    T('Compare broadband providers','personal',p['Home'],4,30,'medium',['research'],14),
    T('Clear the download folder','personal',undefined,4,15,'shallow',[]),
  ]);
  await db.tasks.add({ ...T('Ship the weekly update','work',p['Hiring'],2,30,'medium',[]), status:'done', completedAt:n });
  // Give the availability fields something to render.
  // The title field has no index, so look these up by scan, not where().
  const all = await db.tasks.toArray();
  const byTitle = (t) => all.find((x) => x.title === t);
  const iso = (off) => { const d = new Date(); d.setDate(d.getDate() + off);
    return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); };
  const rollback = byTitle('Write the migration rollback plan');
  await db.tasks.update(rollback.id, { context: 'laptop' });
  await db.tasks.update(byTitle('Review shard cutover checklist').id,
    { context: 'laptop', blockedBy: rollback.id });
  await db.tasks.update(byTitle('Reply to candidate scheduling thread').id,
    { context: 'phone', blockedNote: 'the hiring manager to confirm the panel' });
  await db.tasks.update(byTitle('Book the annual physical').id, { context: 'phone' });
  await db.tasks.update(byTitle('Fix the leaking kitchen tap').id, { context: 'home' });
  await db.tasks.update(byTitle('Compare broadband providers').id,
    { context: 'errand', startDate: iso(4) });
  return 'ok';
})()`);
await send('Page.navigate', { url });
await new Promise((r) => setTimeout(r, 3500));

const clickTab = (label) =>
  js(`(()=>{
    const b=[...document.querySelectorAll('nav button')].find(x=>x.innerText.trim()===${JSON.stringify(label)});
    if(!b) throw new Error('no tab '+${JSON.stringify(label)});
    b.click(); return 'ok';
  })()`);

const shot = async (name) => {
  const h = await js(`Math.min(document.documentElement.scrollHeight, 2400)`);
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: h,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await new Promise((r) => setTimeout(r, 400));
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${outDir}/${name}.png`, Buffer.from(data, 'base64'));
  console.log('wrote', `${outDir}/${name}.png`, `(1440x${h})`);
};

for (const [tab, name] of [
  ['Focus', 'focus'],
  ['Tasks', 'tasks'],
  ['Projects', 'projects'],
  ['jAIme', 'chat'],
  ['Sync', 'sync'],
]) {
  await clickTab(tab);
  await new Promise((r) => setTimeout(r, 900));
  await shot(name);
}

// The task dialog and its calendar are only reachable through interaction, but
// they are the densest surfaces in the app, so capture them too.
await clickTab('Tasks');
await new Promise((r) => setTimeout(r, 700));
await js(`(()=>{
  [...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='+ New task').click();
  return 'ok';
})()`);
await new Promise((r) => setTimeout(r, 700));
await shot('dialog');
await js(`(()=>{
  const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='No due date');
  if(!b) throw new Error('no due-date trigger'); b.click(); return 'ok';
})()`);
await new Promise((r) => setTimeout(r, 600));
await shot('dialog-calendar');

// The focus session replaces the whole app, so it can only be captured from a
// clean page — close the dialog and start one from the recommendation.
await js(`(()=>{
  const b=[...document.querySelectorAll('button')].find(x=>/^(Cancel|Close)$/.test(x.innerText.trim()));
  if(b) b.click(); else document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  return 'ok';
})()`);
await new Promise((r) => setTimeout(r, 600));
await clickTab('Focus');
await new Promise((r) => setTimeout(r, 800));
await js(`(()=>{
  const b=document.querySelector('[data-start-task]');
  if(!b) throw new Error('no Start button on the recommendation');
  b.click(); return 'ok';
})()`);
await new Promise((r) => setTimeout(r, 900));
for (const step of ['Pull the current numbers', 'Draft the summary', 'Send it for review']) {
  await js(`(()=>{
    const i=document.querySelector('[data-session] input');
    if(!i) throw new Error('no checklist input');
    const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    set.call(i, ${JSON.stringify(step)});
    i.dispatchEvent(new Event('input',{bubbles:true}));
    const add=[...document.querySelectorAll('[data-session] button')]
      .find(b=>b.innerText.trim()==='Add');
    if(!add) throw new Error('no Add button'); add.click(); return 'ok';
  })()`);
  await new Promise((r) => setTimeout(r, 350));
}
await js(`(()=>{
  const box=document.querySelector('[data-checklist-item] input[type=checkbox]');
  if(box) box.click(); return 'ok';
})()`);
await new Promise((r) => setTimeout(r, 700));
await shot('session');

await js(`(()=>{
  const b=[...document.querySelectorAll('[data-session] button')]
    .find(x=>x.innerText.trim().split('\\n')[0].trim()==='I’m stuck');
  if(!b) throw new Error('no stuck control'); b.click(); return 'ok';
})()`);
await new Promise((r) => setTimeout(r, 600));
await shot('session-stuck');

ws.close();
process.exit(0);
