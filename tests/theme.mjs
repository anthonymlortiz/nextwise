// Does the light theme actually work, and is anything illegible in either one?
//
// The palette is a set of CSS variables that `@media (prefers-color-scheme)`
// redefines, so a single hardcoded `text-white` or `bg-black/60` left behind in
// a component survives the flip and turns into white-on-white. Rather than
// assert on class names — which say nothing about what the pixel ends up being —
// this suite reads getComputedStyle, which has already resolved var() and
// color-mix(), composites every translucent layer down to an opaque colour, and
// computes the real WCAG contrast ratio.
import { connect, reporter } from './lib.mjs';

const t = await connect();
const r = reporter();
const js = t.js;
const wait = (ms) => new Promise((z) => setTimeout(z, ms));
const eq = (n, a, e) =>
  r.ok(n, JSON.stringify(a) === JSON.stringify(e), `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
const atLeast = (n, a, min) => r.ok(n, a >= min, `expected >= ${min}, got ${a}`);

// WCAG relative luminance and contrast, plus alpha compositing so that a
// `color-mix(... 60%, transparent)` fill is measured as what the eye sees.
//
// Colours are rasterised through a 1x1 canvas rather than parsed with a regex.
// Tailwind v4's palette is authored in oklch and Chrome serialises an
// opacity-modified colour as `oklab(0.5 -0.003 -0.035 / 0.6)`, whose numbers are
// not channels at all — reading them as RGB makes every measurement plausible
// and wrong. The canvas converts any CSS colour syntax to the sRGB bytes that
// actually reach the screen.
const HELPERS = `(() => {
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const cv = document.createElement('canvas');
  cv.width = cv.height = 1;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.globalCompositeOperation = 'copy';
  const parse = (s) => {
    ctx.fillStyle = '#000000';
    ctx.fillStyle = s || 'rgba(0,0,0,0)';
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };
  const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));
  const bgOf = (el) => {
    const layers = [];
    for (let n = el; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c[3] > 0) layers.push(c);
    }
    let base = [255, 255, 255];
    for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
    return base;
  };
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)];
    return Math.round(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)) * 100) / 100;
  };
  window.__bg = (sel) => { const e = document.querySelector(sel); return e ? bgOf(e) : null; };
  window.__contrastOf = (el) => {
    const bg = bgOf(el);
    return ratio(over(parse(getComputedStyle(el).color), bg), bg);
  };
  // Only leaf-ish elements that actually paint text, so a wrapper div does not
  // get blamed for the colour of a child it merely contains.
  window.__textNodes = () => [...document.querySelectorAll('body *')].filter((el) => {
    if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    if (getComputedStyle(el).visibility === 'hidden') return false;
    return [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
  });
  // Disabled controls are exempt from WCAG contrast and are checked separately
  // against a looser bar, so they would otherwise dominate this list.
  window.__worstText = (n) => window.__textNodes()
    .filter((el) => !el.closest('[disabled]'))
    .map((el) => ({
      text: el.textContent.trim().slice(0, 40),
      tag: el.tagName.toLowerCase(),
      disabled: !!el.closest('[disabled]'),
      contrast: window.__contrastOf(el),
    }))
    .sort((a, b) => a.contrast - b.contrast)
    .slice(0, n);
  // Rails, dots and swatches carry meaning without text, so they have to be
  // distinguishable from the surface they sit on too.
  window.__decorContrast = (sel) => [...document.querySelectorAll(sel)].map((el) => {
    const own = parse(getComputedStyle(el).backgroundColor);
    const behind = bgOf(el.parentElement);
    return { cls: el.className.split(' ').slice(-1)[0], alpha: own[3], contrast: ratio(over(own, behind), behind) };
  });
  return 'ok';
})()`;

const seed = `(async () => {
  const { db } = window.__fb;
  await db.tasks.clear(); await db.projects.clear();
  const n = Date.now();
  const pid = await db.projects.add({ name: 'Platform Migration', domain: 'work', color: '#6366f1', createdAt: n });
  const T = (title, priority, focusLevel, dueOffset) => {
    const d = new Date(); d.setDate(d.getDate() + dueOffset);
    return { title, notes: 'Spec at https://example.com/spec', domain: 'work', projectId: pid, priority, estimateMin: 30,
      focusLevel, status: 'todo', tags: ['writing'], createdAt: n, updatedAt: n,
      dueDate: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') };
  };
  await db.tasks.bulkAdd([T('Overdue P1 task', 1, 'deep', -2), T('Due today P2', 2, 'medium', 0),
    T('Later P3 task', 3, 'shallow', 5), T('Someday P4 task', 4, 'shallow', 30)]);
  // The availability fields paint their own badge, chips and a muted rail, so
  // they have to be on screen or the sweeps below never see them. The four rows
  // above stay unblocked: they are what the priority-rail assertions measure.
  const all = await db.tasks.toArray();
  const blocker = all.find(x => x.title === 'Overdue P1 task');
  await db.tasks.update(blocker.id, { context: 'laptop' });
  await db.tasks.update(all.find(x => x.title === 'Due today P2').id, { context: 'phone' });
  await db.tasks.update(all.find(x => x.title === 'Later P3 task').id, { context: 'errand' });
  const soon = new Date(); soon.setDate(soon.getDate() + 3);
  const ymd = soon.getFullYear() + '-' + String(soon.getMonth() + 1).padStart(2, '0')
    + '-' + String(soon.getDate()).padStart(2, '0');
  await db.tasks.bulkAdd([
    { ...T('Blocked by another task', 2, 'medium', 4), blockedBy: blocker.id },
    { ...T('Waiting on the courier', 3, 'shallow', 6), blockedNote: 'the courier' },
    { ...T('Not startable yet', 2, 'medium', 9), startDate: ymd, context: 'office' },
  ]);
  return 'seeded';
})()`;

/** Reload the app under an emulated colour scheme and re-inject the helpers. */
async function load(scheme) {
  await t.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: scheme }],
  });
  await t.send('Page.navigate', { url: t.url });
  await wait(2500);
  await js(HELPERS);
}

const tab = (label) => js(`(()=>{
  const b = [...document.querySelectorAll('nav button')].find(x => x.innerText.trim() === ${JSON.stringify(label)});
  if (!b) throw new Error('no tab ' + ${JSON.stringify(label)});
  b.click(); return 'ok';
})()`);

await js(seed);
await load('dark');

r.section('1. The scheme actually flips');
const dark = await js(`({
  scheme: getComputedStyle(document.documentElement).colorScheme,
  page: getComputedStyle(document.body).backgroundColor,
  fg: getComputedStyle(document.documentElement).getPropertyValue('--color-fg').trim(),
  card: __bg('main [class*=rounded-2xl]'),
})`);
eq('dark declares color-scheme: dark', dark.scheme, 'dark');
r.ok('dark page is near black', dark.page.includes('8, 10, 17'), dark.page);
eq('dark primary text token is white', dark.fg, '#ffffff');

await load('light');
const light = await js(`({
  scheme: getComputedStyle(document.documentElement).colorScheme,
  page: getComputedStyle(document.body).backgroundColor,
  fg: getComputedStyle(document.documentElement).getPropertyValue('--color-fg').trim(),
  card: __bg('main [class*=rounded-2xl]'),
})`);
eq('light declares color-scheme: light', light.scheme, 'light');
r.ok('light page is near white', light.page.includes('236, 239, 246'), light.page);
eq('light primary text token is dark', light.fg, '#0b1020');
// The tokens are semantic, not literal: a card is the raised surface in both
// themes, so it must stay lighter than the page in dark and in light alike.
r.ok('cards are lighter than the page in dark', dark.card[0] > 8, JSON.stringify(dark.card));
r.ok('cards are lighter than the page in light', light.card[0] > 236, JSON.stringify(light.card));

r.section('2. Nothing is illegible in light mode');
for (const [label, name] of [['Focus', 'focus'], ['Tasks', 'tasks'], ['Projects', 'projects'], ['Sync', 'sync']]) {
  await tab(label);
  await wait(500);
  const worst = await js(`__worstText(4)`);
  atLeast(`light ${name}: worst text contrast`, worst[0].contrast, 4.5);
  if (worst[0].contrast < 4.5) console.log('     ', JSON.stringify(worst, null, 1));
}

r.section('3. Nothing is illegible in dark mode');
await load('dark');
for (const [label, name] of [['Focus', 'focus'], ['Tasks', 'tasks'], ['Projects', 'projects'], ['Sync', 'sync']]) {
  await tab(label);
  await wait(500);
  const worst = await js(`__worstText(4)`);
  atLeast(`dark ${name}: worst text contrast`, worst[0].contrast, 4.5);
  if (worst[0].contrast < 4.5) console.log('     ', JSON.stringify(worst, null, 1));
}

r.section('4. Non-text signals survive both themes');
for (const scheme of ['dark', 'light']) {
  await load(scheme);
  await tab('Tasks');
  await wait(500);
  const rails = await js(`__decorContrast('[data-rail-muted="0"]')`);
  eq(`${scheme}: every actionable task row has a rail`, rails.length, 4);
  r.ok(`${scheme}: rails are painted, not transparent`, rails.every((x) => x.alpha > 0),
    JSON.stringify(rails));
  // P1 through P3 are meant to be spotted at a glance; P4 is deliberately almost
  // silent, so it only has to be perceptible at all.
  atLeast(`${scheme}: P1 rail stands out`, rails[0].contrast, 3);
  atLeast(`${scheme}: P2 rail stands out`, rails[1].contrast, 3);
  atLeast(`${scheme}: P3 rail is visible`, rails[2].contrast, 1.3);
  atLeast(`${scheme}: P4 rail is at least perceptible`, rails[3].contrast, 1.05);

  // A blocked or not-yet-startable row drops its priority colour: the rail is
  // how "you cannot start this" is signalled without spending another colour.
  const muted = await js(`__decorContrast('[data-rail-muted="1"]')`);
  eq(`${scheme}: the unavailable rows are muted`, muted.length, 3);
  r.ok(`${scheme}: a muted rail is still painted`, muted.every((x) => x.alpha > 0),
    JSON.stringify(muted));
  r.ok(`${scheme}: a muted P2 is quieter than an actionable one`,
    muted.every((x) => x.contrast < rails[1].contrast),
    JSON.stringify({ muted: muted.map((x) => x.contrast), p2: rails[1].contrast }));

  await tab('Sync');
  await wait(500);
  // Regression: this dot used an undefined token, so it rendered transparent and
  // "Not connected" had no status light next to it at all.
  const dots = await js(`__decorContrast('[data-status-dot]')`);
  eq(`${scheme}: both providers show a status dot`, dots.length, 2);
  r.ok(`${scheme}: status dots are painted`, dots.every((x) => x.alpha > 0), JSON.stringify(dots));
  atLeast(`${scheme}: status dot is visible`, Math.min(...dots.map((d) => d.contrast)), 1.4);
}

r.section('5. Disabled controls stay readable');
for (const scheme of ['dark', 'light']) {
  await load(scheme);
  await tab('Sync');
  await wait(500);
  // A translucent accent fill under white text reads fine on a dark page and
  // becomes pale-lavender-on-white in light mode, so disabled buttons use a
  // neutral chip instead.
  const disabled = await js(`(() => {
    const b = [...document.querySelectorAll('button')].filter(x => x.disabled && x.innerText.trim());
    return b.map(x => ({ text: x.innerText.trim(), contrast: __contrastOf(x) }));
  })()`);
  r.ok(`${scheme}: sync tab has disabled buttons to check`, disabled.length > 0, JSON.stringify(disabled));
  atLeast(`${scheme}: disabled button label is readable`,
    Math.min(...disabled.map((d) => d.contrast)), 3);
}

const passed = r.done(t.errors);
t.close();
process.exit(passed ? 0 : 1);
