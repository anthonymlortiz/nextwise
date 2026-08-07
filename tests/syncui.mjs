import { connect, reporter } from './lib.mjs';

const t = await connect();
const r = reporter();
const js = t.js;
const wait = ms => new Promise(z => setTimeout(z, ms));
const eq = (name, actual, expected) =>
  r.ok(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const reload = async () => {
  await t.send('Page.navigate', { url: t.url });
  await wait(2500);
};
// The GitHub backup card sits above the provider cards and has its own Save
// buttons and checkboxes, so provider lookups have to say which half of the tab
// they mean rather than trusting document order.
const OUTSIDE = (sel) =>
  `[...document.querySelectorAll(${JSON.stringify(sel)})].filter(e => !e.closest('[data-backup-panel]'))`;
const OUTSIDE_BACKUP = OUTSIDE('button');
const click = async (text) => js(`(() => {
  const el = ${OUTSIDE_BACKUP}.find(b => b.innerText.trim().toLowerCase() === ${JSON.stringify(text)}.toLowerCase());
  if (!el) throw new Error('no button: ' + ${JSON.stringify(text)});
  el.click(); return 'ok';
})()`);
const btn = (frag, prop) => js(`${OUTSIDE_BACKUP}.find(b=>b.innerText.includes(${JSON.stringify(frag)})).${prop}`);
const autoBox = OUTSIDE('input[type=checkbox]') + '[0]';
const text = frag => js(`document.body.innerText.includes(${JSON.stringify(frag)})`);

await js(`localStorage.removeItem('pp.msal.clientId'); localStorage.removeItem('pp.gis.clientId');
          localStorage.removeItem('pp.gis.connected'); localStorage.removeItem('pp.sync.auto');
          Object.keys(localStorage).filter(k => k.startsWith('pp.backup.')).forEach(k => localStorage.removeItem(k)); 'x'`);
await reload();

r.section('1. Sync tab renders a card per provider');
await click('Sync'); await wait(200);
eq('microsoft card shown', await js(`document.body.innerText.toUpperCase().includes('MICROSOFT TO DO')`), true);
eq('google card shown', await js(`document.body.innerText.toUpperCase().includes('GOOGLE TASKS')`), true);
eq('microsoft client id field present', await js(`!!document.querySelector('input[placeholder^="00000000"]')`), true);
eq('google client id field present', await js(`!!document.querySelector('input[placeholder*="googleusercontent"]')`), true);
eq('both start disconnected', await js(`(document.body.innerText.match(/Not connected/g)||[]).length`), 2);
eq('microsoft setup steps auto-open', await text('entra.microsoft.com'), true);
eq('google setup steps auto-open', await text('console.cloud.google.com'), true);
eq('google needs no redirect uri', await text('Leave redirect URIs empty'), true);
eq('origin shown verbatim', await js(`[...document.querySelectorAll('code')].some(c=>c.innerText.trim()===location.origin)`), true);
// A root build must keep offering the bare origin. Entra matches redirect URIs
// exactly, so gaining a trailing slash here would invalidate every existing
// registration rather than fail loudly.
const registerUri = (label) => `(() => {
  const lab = [...document.querySelectorAll('div')].find(d => d.innerText.trim().toUpperCase().startsWith('${label}'));
  return lab?.parentElement.querySelector('code')?.innerText.trim() ?? null;
})()`;
eq('microsoft redirect uri is the bare origin', await js(registerUri('REDIRECT URI')), await js(`location.origin`));
// Google validates the calling origin, which can never carry a path.
eq('google origin carries no path', await js(registerUri('AUTHORIZED JAVASCRIPT ORIGIN')), await js(`location.origin`));
eq('connect disabled without client id', await btn('Connect Microsoft To Do', 'disabled'), true);
eq('google connect disabled too', await btn('Connect Google Tasks', 'disabled'), true);
eq('sync all disabled when nothing connected', await btn('Sync all', 'disabled'), true);
eq('last synced shows never', await text('never'), true);
eq('google footer caveat explained', await text('ride along in the task notes'), true);

r.section('2. Saving a client id enables connecting');
await js(`(() => {
  const i = document.querySelector('input[placeholder^="00000000"]');
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(i, '11111111-2222-3333-4444-555555555555');
  i.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';
})()`);
await wait(120);
eq('save enabled once edited', await btn('Save', 'disabled'), false);
await click('Save'); await wait(200);
eq('client id persisted', await js(`localStorage.getItem('pp.msal.clientId')`), '11111111-2222-3333-4444-555555555555');
eq('connect now enabled', await btn('Connect Microsoft To Do', 'disabled'), false);
eq('save disabled again after saving', await btn('Save', 'disabled'), true);
eq('google still needs its own id', await btn('Connect Google Tasks', 'disabled'), true);

r.section('2b. Each provider stores its own client id');
await js(`(() => {
  const i = document.querySelector('input[placeholder*="googleusercontent"]');
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(i, '9999-abc.apps.googleusercontent.com');
  i.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';
})()`);
await wait(120);
await js(`${OUTSIDE_BACKUP}.filter(b=>b.innerText.trim()==='Save')[1].click(); 'ok'`);
await wait(200);
eq('google id persisted separately', await js(`localStorage.getItem('pp.gis.clientId')`), '9999-abc.apps.googleusercontent.com');
eq('microsoft id untouched', await js(`localStorage.getItem('pp.msal.clientId')`), '11111111-2222-3333-4444-555555555555');
eq('google connect now enabled', await btn('Connect Google Tasks', 'disabled'), false);

r.section('3. Client id survives a reload');
await reload(); await click('Sync'); await wait(200);
eq('field repopulated', await js(`document.querySelector('input[placeholder^="00000000"]').value`), '11111111-2222-3333-4444-555555555555');
eq('google field repopulated', await js(`document.querySelector('input[placeholder*="googleusercontent"]').value`), '9999-abc.apps.googleusercontent.com');
eq('setup steps collapsed once configured', await text('entra.microsoft.com'), false);

r.section('4. MSAL lazy-loads and initialises');
// Start from an unconfigured page so nothing has had a reason to touch MSAL yet.
await js(`localStorage.removeItem('pp.msal.clientId'); 'ok'`);
await reload();
const msalLoaded = () => js(`performance.getEntriesByType('resource').some(x=>/msal/i.test(x.name))`);
eq('not loaded on a cold start', await msalLoaded(), false);
await click('Sync'); await wait(250);
eq('not loaded by opening the sync tab', await msalLoaded(), false);
eq('getAccount short-circuits without a client id', await js(`window.__fb.auth.getAccount()`), null);
eq('still not loaded', await msalLoaded(), false);
await js(`window.__fb.auth.setClientId('11111111-2222-3333-4444-555555555555'); 'ok'`);
eq('getAccount is null when never signed in', await js(`window.__fb.auth.getAccount()`), null);
eq('loaded on demand once configured', await msalLoaded(), true);
eq('scopes are least-privilege', await js(`window.__fb.auth.GRAPH_SCOPES`), ['Tasks.ReadWrite']);
eq('google identity script stays out of it', await js(`performance.getEntriesByType('resource').some(x=>/gsi\\/client/.test(x.name))`), false);

r.section('5. Missing client id is a friendly error, not a crash');
await js(`window.__fb.auth.setClientId(''); 'ok'`);
eq('typed error when unconfigured',
   await js(`window.__fb.auth.getAccessToken().then(()=>'no-throw', e=>e.name)`), 'AuthNotConfiguredError');
eq('error message is actionable',
   await js(`window.__fb.auth.getAccessToken().then(()=>'', e=>e.message)`), 'Add your Azure application (client) ID before connecting.');
await js(`window.__fb.auth.setClientId('11111111-2222-3333-4444-555555555555'); 'ok'`);

r.section('6. Auto-sync toggle persists');
await reload(); await click('Sync'); await wait(200);
eq('auto-sync off by default', await js(`${autoBox}.checked`), false);
await js(`${autoBox}.click(); 'ok'`); await wait(150);
eq('stored as enabled', await js(`localStorage.getItem('pp.sync.auto')`), '1');
await reload(); await click('Sync'); await wait(200);
eq('still checked after reload', await js(`${autoBox}.checked`), true);
await js(`${autoBox}.click(); 'ok'`); await wait(150);
eq('stored as disabled', await js(`localStorage.getItem('pp.sync.auto')`), '0');

r.section('7. Reset links asks before acting');
eq('confirm hidden initially', await text('No tasks are'), false);
await js(`${OUTSIDE_BACKUP}.find(b=>b.innerText.includes('Reset sync links')).click(); 'ok'`);
await wait(150);
eq('confirmation shown', await text('No tasks are'), true);
await click('Cancel'); await wait(150);
eq('cancel backs out', await text('No tasks are'), false);

r.section('8. Reset clears one provider without touching the other');
await js(`window.__fb.runSync(window.__fb.msProvider(new window.__fb.FakeGraphClient({withDefaultList:true}))).then(x=>x.ok)`);
await js(`window.__fb.runSync(window.__fb.googleProvider(new window.__fb.FakeGoogleClient({withDefaultList:true}))).then(x=>x.ok)`);
const msLinks = await js(`window.__fb.db.syncLinks.where('provider').equals('mstodo').count()`);
const gLinks = await js(`window.__fb.db.syncLinks.where('provider').equals('gtasks').count()`);
r.ok('microsoft links created', msLinks > 0, `links=${msLinks}`);
r.ok('google links created independently', gLinks > 0, `links=${gLinks}`);
const total = await js(`window.__fb.db.tasks.count()`);
await js(`${OUTSIDE_BACKUP}.find(b=>b.innerText.includes('Reset sync links')).click(); 'ok'`);
await wait(150);
await click('Reset links'); await wait(400);
eq('microsoft links dropped', await js(`window.__fb.db.syncLinks.where('provider').equals('mstodo').count()`), 0);
eq('google links survive', await js(`window.__fb.db.syncLinks.where('provider').equals('gtasks').count()`), gLinks);
eq('no tasks lost', await js(`window.__fb.db.tasks.count()`), total);
eq('microsoft sync state cleared', await js(`window.__fb.getLastSyncAt('mstodo').then(v=>v===undefined)`), true);
eq('google sync state kept', await js(`window.__fb.getLastSyncAt('gtasks').then(v=>typeof v)`), 'number');

r.section('9. Other tabs still work');
// The focus context defaults to "work", so don't rely on whatever the previous
// suite happened to leave behind — give it something it must recommend.
await js(`window.__fb.db.tasks.add({ title:'Recommend me', notes:'', domain:'work',
  priority:1, estimateMin:15, focusLevel:'shallow', status:'todo', tags:[],
  createdAt: Date.now(), updatedAt: Date.now() })`);
await click('Focus'); await wait(250);
eq('focus panel still recommends', await js(`document.body.innerText.toUpperCase().includes('JAIME RECOMMENDS')`), true);
eq('recommendation names a task', await js(`document.body.innerText.includes('match score')`), true);
await click('Tasks'); await wait(250);
eq('tasks panel lists tasks', await js(`/\\d+ shown/.test(document.body.innerText)`), true);
eq('task rows rendered', await js(`[...document.querySelectorAll('button')].filter(b=>b.innerText.trim()==='Edit').length > 0`), true);

r.section('10. The GitHub backup card is set up separately');
await click('Sync'); await wait(250);
const bk = (sel, prop) => js(`document.querySelector('[data-backup-panel] ${sel}').${prop}`);
eq('the card is on the sync tab', await js(`!!document.querySelector('[data-backup-panel]')`), true);
eq('and starts unconfigured', await bk('[data-backup-dot]', `dataset.backupDot`), 'not-ready');
// Turn unattended saving off first: everything below pastes credentials, and
// leaving it on would send this browser off to github.com mid-test.
await js(`[...document.querySelectorAll('[data-backup-panel] input[type=checkbox]')].pop().click(); 'ok'`);
await wait(150);
eq('automatic saving can be turned off', await js(`localStorage.getItem('pp.backup.auto')`), '0');
// Saving is the whole feature, so it must not look available before it can run.
eq('sync now is not offered yet', await js(`[...document.querySelectorAll('[data-backup-panel] button')].find(b=>b.innerText.includes('Sync now')).disabled`), true);
eq('setup steps open on their own', await text('Read and write'), true);
eq('and say the repository must be private', await text('Make it Private'), true);
// A token in local storage is a real trade-off; the panel has to admit it
// rather than let the checkbox imply it is free.
eq('the token warning is stated plainly', await text('could read it'), true);

const type = (sel, value) => js(`(() => {
  const i = document.querySelector('[data-backup-panel] ${sel}');
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(i, ${JSON.stringify(value)});
  i.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';
})()`);
const backupBtn = (frag, prop) => js(`[...document.querySelectorAll('[data-backup-panel] button')].find(b=>b.innerText.includes(${JSON.stringify(frag)})).${prop}`);

await type('[data-backup-repo]', 'not a repo at all');
await wait(150);
eq('nonsense is refused before it can 404', await text('or paste the repository'), true);
eq('and cannot be saved', await backupBtn('Save repository', 'disabled'), true);

// The three shapes people paste all have to reach the same place.
await type('[data-backup-repo]', 'https://github.com/someone/nextwise-data.git');
await wait(150);
eq('a pasted address is accepted', await backupBtn('Save repository', 'disabled'), false);
await js(`[...document.querySelectorAll('[data-backup-panel] button')].find(b=>b.innerText.includes('Save repository')).click(); 'ok'`);
await wait(200);
eq('the owner is stored', await js(`JSON.parse(localStorage.getItem('pp.backup.repo')).owner`), 'someone');
eq('and the repository', await js(`JSON.parse(localStorage.getItem('pp.backup.repo')).repo`), 'nextwise-data');
eq('with a default file path', await js(`JSON.parse(localStorage.getItem('pp.backup.repo')).path`), 'nextwise/board.json');

await type('[data-backup-token]', 'hunter2');
await wait(150);
eq('a token that is not one is flagged', await text('Check the paste'), true);

await type('[data-backup-token]', 'github_pat_11ABCDEFG_pretendtoken');
await wait(150);
eq('a real-looking token is not', await text('Check the paste'), false);
await js(`[...document.querySelectorAll('[data-backup-panel] button')].find(b=>b.innerText.trim()==='Save').click(); 'ok'`);
await wait(250);
eq('the token is kept for next time', await js(`localStorage.getItem('pp.backup.token')`), 'github_pat_11ABCDEFG_pretendtoken');
eq('the field is cleared once saved', await bk('[data-backup-token]', 'value'), '');
eq('and the card reports it is saving', await bk('[data-backup-dot]', 'dataset.backupDot'), 'ready');

// Nothing above should have disturbed the providers sharing the tab.
eq('the provider cards are untouched', await js(`(document.body.innerText.match(/Not connected/g)||[]).length`), 2);

await js(`[...document.querySelectorAll('[data-backup-panel] button')].find(b=>b.innerText.includes('Forget token')).click(); 'ok'`);
await wait(150);
await js(`[...document.querySelectorAll('[data-backup-panel] button')].find(b=>b.innerText.trim()==='Forget token').click(); 'ok'`);
await wait(250);
eq('forgetting removes the stored token', await js(`localStorage.getItem('pp.backup.token')`), null);
eq('and stops the saving', await bk('[data-backup-dot]', 'dataset.backupDot'), 'not-ready');
eq('but keeps the repository', await js(`JSON.parse(localStorage.getItem('pp.backup.repo')).repo`), 'nextwise-data');
await js(`Object.keys(localStorage).filter(k => k.startsWith('pp.backup.')).forEach(k => localStorage.removeItem(k)); 'x'`);

const okAll = r.done(t.errors);
t.close();
process.exit(okAll ? 0 : 1);
