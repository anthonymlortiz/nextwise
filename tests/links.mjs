// Links typed into a task's title or notes should be clickable.
//
// The parser is the security boundary here: notes are free text that can also
// arrive from Microsoft To Do or Google Tasks, so anything that looks like a
// scheme must not become a working link unless it is one we chose to allow.
import { connect, reporter } from './lib.mjs';

const t = await connect();
const r = reporter();
const js = t.js;
const wait = (ms) => new Promise((z) => setTimeout(z, ms));
const eq = (n, a, e) =>
  r.ok(n, JSON.stringify(a) === JSON.stringify(e), `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);

const L = (expr) => js(`import('/src/linkify.ts').then(m => (${expr}))`);
/** The hrefs a string produces, in order — the shape most assertions care about. */
const hrefs = (text) => L(`m.linkify(${JSON.stringify(text)}).filter(s => s.kind === 'link').map(s => s.href)`);
const texts = (text) => L(`m.linkify(${JSON.stringify(text)}).filter(s => s.kind === 'link').map(s => s.text)`);

r.section('1. What counts as a link');
eq('plain prose has none', await hrefs('just some notes'), []);
eq('an https url', await hrefs('see https://example.com/a'), ['https://example.com/a']);
eq('an http url', await hrefs('see http://example.com'), ['http://example.com']);
eq('a bare www host gains a scheme', await hrefs('see www.example.com'), ['https://www.example.com']);
eq('an email becomes mailto', await hrefs('ping bob@example.com'), ['mailto:bob@example.com']);
eq('query strings and fragments survive',
  await hrefs('https://example.com/a?b=1&c=2#frag'), ['https://example.com/a?b=1&c=2#frag']);
eq('several links in one note',
  await hrefs('https://a.com then www.b.com then c@d.com'),
  ['https://a.com', 'https://www.b.com', 'mailto:c@d.com']);
eq('links survive across newlines',
  await hrefs('line one\nhttps://a.com\nline three'), ['https://a.com']);
eq('a host glued to a word is not a link', await hrefs('seehttps://example.com'), []);
eq('a bare domain is left alone', await hrefs('example.com is the site'), []);

r.section('2. Punctuation around a link is not part of it');
eq('a trailing full stop', await texts('see https://example.com.'), ['https://example.com']);
eq('a trailing comma', await texts('https://example.com, then'), ['https://example.com']);
eq('a trailing question mark', await texts('did you read https://example.com?'), ['https://example.com']);
eq('an unbalanced closing paren', await texts('(see https://example.com)'), ['https://example.com']);
// Wikipedia and many docs sites put brackets inside the path itself.
eq('balanced parens belong to the url',
  await texts('https://en.wikipedia.org/wiki/Ruby_(gem)'), ['https://en.wikipedia.org/wiki/Ruby_(gem)']);
eq('balanced parens plus a trailing stop',
  await texts('https://en.wikipedia.org/wiki/Ruby_(gem).'), ['https://en.wikipedia.org/wiki/Ruby_(gem)']);
eq('angle brackets are delimiters', await texts('<https://example.com>'), ['https://example.com']);
eq('quotes are delimiters', await texts('"https://example.com"'), ['https://example.com']);

r.section('3. Only http, https and mailto can ever come out');
// The regression this guards against: a note pasted from anywhere, or synced in
// from a provider, turning into a clickable script.
eq('javascript: is not a link', await hrefs('javascript:alert(1)'), []);
eq('javascript: inside prose is not a link', await hrefs('try javascript:alert(document.cookie) here'), []);
eq('data: is not a link', await hrefs('data:text/html,<script>alert(1)</script>'), []);
eq('vbscript: is not a link', await hrefs('vbscript:msgbox(1)'), []);
eq('file: is not a link', await hrefs('file:///etc/passwd'), []);
eq('a scheme smuggled into a path stays part of the url',
  await hrefs('https://example.com/javascript:alert(1)'), ['https://example.com/javascript:alert(1)']);
eq('hrefFor rejects anything it did not match', await L(`m.hrefFor('javascript:alert(1)')`), null);
eq('hrefFor rejects a protocol-relative url', await L(`m.hrefFor('//evil.com')`), null);
eq('every href uses an allowed scheme', await L(`
  ['https://a.com','www.a.com','a@b.com','javascript:x','data:x','ftp://a.com','//a.com','tel:123']
    .map(s => m.hrefFor(s))
    .filter(Boolean)
    .every(h => /^(https?|mailto):/.test(h))`), true);

r.section('4. Nothing is lost or rewritten on screen');
// Segments are a view over the original string, so reassembling them has to
// give the input back exactly — otherwise the note shown differs from the note
// stored and pushed to a provider.
const roundTrip = (s) => L(`m.linkify(${JSON.stringify(s)}).map(x => x.text).join('') === ${JSON.stringify(s)}`);
eq('round-trips plain prose', await roundTrip('nothing to see here'), true);
eq('round-trips a trailing stop', await roundTrip('see https://example.com.'), true);
eq('round-trips parens', await roundTrip('(https://example.com) and (b)'), true);
eq('round-trips mixed content', await roundTrip('a https://x.com b www.y.com c d@e.com f'), true);
eq('round-trips newlines and spacing', await roundTrip('  a\n\n  https://x.com  \nb'), true);
eq('round-trips a lone url', await roundTrip('https://example.com'), true);
eq('empty text yields no segments', await L(`m.linkify('').length`), 0);

r.section('5. The rendered task row');
await js(`(async () => {
  const { db } = window.__fb;
  await db.tasks.clear(); await db.projects.clear();
  const n = Date.now();
  await db.tasks.add({ title: 'Read https://example.com/spec', notes: 'Docs at www.example.org and mail bob@example.com',
    domain: 'work', priority: 2, estimateMin: 30, focusLevel: 'medium', status: 'todo',
    tags: [], createdAt: n, updatedAt: n });
  await db.tasks.add({ title: 'Nothing linkable here', notes: 'plain note',
    domain: 'work', priority: 3, estimateMin: 15, focusLevel: 'shallow', status: 'todo',
    tags: [], createdAt: n, updatedAt: n });
  return 'seeded';
})()`);
await t.send('Page.navigate', { url: t.url });
await wait(2500);
await js(`[...document.querySelectorAll('nav button')].find(b => b.innerText.trim() === 'Tasks').click(); 'ok'`);
await wait(600);

const anchors = await js(`[...document.querySelectorAll('main a')].map(a => ({
  href: a.getAttribute('href'), target: a.target, rel: a.rel, text: a.innerText.trim(),
}))`);
eq('a link in the title, and two in the notes', anchors.length, 3);
eq('the title url is linked', anchors[0].href, 'https://example.com/spec');
eq('the www host is linked with a scheme', anchors[1].href, 'https://www.example.org');
eq('the email is linked as mailto', anchors[2].href, 'mailto:bob@example.com');
r.ok('links open in a new tab', anchors.every((a) => a.target === '_blank'),
  JSON.stringify(anchors.map((a) => a.target)));
// Without noopener the opened page gets a handle on this one via window.opener.
r.ok('links carry noopener and noreferrer',
  anchors.every((a) => a.rel.includes('noopener') && a.rel.includes('noreferrer')),
  JSON.stringify(anchors.map((a) => a.rel)));

// Restyling and linkifying must not disturb the text the other suites assert on.
eq('the title still reads as typed',
  await js(`[...document.querySelectorAll('main div')].some(d => d.innerText.trim() === 'Read https://example.com/spec')`), true);
eq('the notes still read as typed',
  await js(`[...document.querySelectorAll('main p')].some(p => p.innerText.trim() === 'Docs at www.example.org and mail bob@example.com')`), true);
eq('a task without links renders no anchors',
  await js(`(() => {
    const row = [...document.querySelectorAll('main p')].find(p => p.innerText.trim() === 'plain note');
    return row.querySelectorAll('a').length;
  })()`), 0);

r.section('6. Following a link does not disturb the task');
const after = await js(`(async () => {
  const a = [...document.querySelectorAll('main a')][0];
  const block = (e) => e.preventDefault();
  document.addEventListener('click', block, true);
  a.click();
  document.removeEventListener('click', block, true);
  await new Promise(z => setTimeout(z, 400));
  const rows = await window.__fb.db.tasks.toArray();
  return rows.map(t => t.status);
})()`);
r.ok('clicking a link leaves both tasks open', after.every((s) => s === 'todo'), JSON.stringify(after));
eq('and the edit dialog did not open',
  await js(`!document.querySelector('input[placeholder="What needs doing?"]')`), true);
// The link colour is a token, so it flips with the theme; theme.mjs sweeps its
// contrast in both schemes.
r.ok('links are visibly distinct from surrounding text',
  await js(`(() => {
    const a = document.querySelector('main p a');
    return getComputedStyle(a).color !== getComputedStyle(a.parentElement).color
      && getComputedStyle(a).textDecorationLine.includes('underline');
  })()`), true);

const passed = r.done(t.errors);
t.close();
process.exit(passed ? 0 : 1);
