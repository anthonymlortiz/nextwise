import { connect, reporter } from './lib.mjs';
const t = await connect(9224, process.env.TEST_URL ?? 'http://localhost:4178/');
const r = reporter();
const js = t.js;
const wait = ms => new Promise(z => setTimeout(z, ms));
const eq = (n,a,e) => r.ok(n, JSON.stringify(a)===JSON.stringify(e), `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
const click = x => js(`(()=>{const el=[...document.querySelectorAll('button')].find(b=>b.innerText.trim().toLowerCase()===${JSON.stringify(x)}.toLowerCase()); if(!el) throw new Error('no btn '+${JSON.stringify(x)}); el.click(); return 'ok';})()`);

r.section('Production build');
eq('app mounted', await js(`!!document.querySelector('h1') && document.querySelector('h1').innerText`), 'Nextwise');
eq('dev hooks stripped', await js(`typeof window.__fb`), 'undefined');
eq('msal not in initial load', await js(`performance.getEntriesByType('resource').some(x=>/msal/i.test(x.name))`), false);
eq('google identity not in initial load', await js(`performance.getEntriesByType('resource').some(x=>/gsi\\/client/.test(x.name))`), false);
await click('Sync'); await wait(300);
eq('microsoft card renders', await js(`document.body.innerText.toUpperCase().includes('MICROSOFT TO DO')`), true);
eq('google card renders', await js(`document.body.innerText.toUpperCase().includes('GOOGLE TASKS')`), true);
eq('microsoft setup guidance present', await js(`document.body.innerText.includes('entra.microsoft.com')`), true);
eq('google setup guidance present', await js(`document.body.innerText.includes('console.cloud.google.com')`), true);
eq('connect gated on client id', await js(`[...document.querySelectorAll('button')].find(b=>b.innerText.includes('Connect Microsoft To Do')).disabled`), true);
eq('google connect gated too', await js(`[...document.querySelectorAll('button')].find(b=>b.innerText.includes('Connect Google Tasks')).disabled`), true);
eq('in-memory fakes stay out of the bundle', await js(`performance.getEntriesByType('resource').filter(x=>/fake/i.test(x.name)).length`), 0);
// The resource check only catches a fake that got its own chunk. These are the
// hooks the fakes are injected through, and they are string property names a
// minifier keeps, so their absence is what actually proves the DEV-only
// branches were eliminated rather than merely inlined.
eq('the dev injection hooks are compiled away', await js(`(async () => {
  const scripts = performance.getEntriesByType('resource').filter(x => /\\.js(\\?|$)/.test(x.name));
  const sources = await Promise.all(scripts.map(s => fetch(s.name).then(r => r.text())));
  return sources.filter(src => /__fbVoiceEngine|__fbChatTransport/.test(src)).length;
})()`), 0);
await click('Focus'); await wait(300);
eq('focus still recommends', await js(`document.body.innerText.toUpperCase().includes('JAIME RECOMMENDS')`), true);
await click('jAIme'); await wait(300);
eq('chat ships in production', await js(`document.body.innerText.toUpperCase().includes('CONNECT JAIME')`), true);
eq('and is gated on the user supplying a key', await js(`!document.querySelector('[aria-label="Message jAIme"]')`), true);
const okAll = r.done(t.errors);
t.close(); process.exit(okAll?0:1);
