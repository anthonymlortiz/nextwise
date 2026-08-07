#!/usr/bin/env node
// Renders public/icon.svg to the PNG sizes a home-screen install needs.
//
//   node scripts/make-icons.mjs
//
// PNGs are committed rather than generated at build time: they change only when
// the mark does, and this needs a browser, which the build must not.
//
// Requires Chrome. Starts and stops its own headless instance on port 9226.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'icons');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9226;

const svg = readFileSync(join(root, 'public', 'icon.svg'), 'utf8');
// A maskable icon is cropped to whatever shape the OS likes, so everything that
// matters has to sit inside the centre 80%. Scaling the artwork down against a
// full-bleed background is what keeps the N off the chopping block.
const maskable = svg
  .replace('<rect width="512" height="512" rx="114"', '<rect width="512" height="512" rx="0"')
  .replace('font-size="288"', 'font-size="224"')
  .replace('y="352"', 'y="330"');

const targets = [
  { name: 'icon-192.png', size: 192, source: svg },
  { name: 'icon-512.png', size: 512, source: svg },
  { name: 'icon-maskable-512.png', size: 512, source: maskable },
  // iOS ignores the manifest icons and reads this one instead.
  { name: 'apple-touch-icon.png', size: 180, source: svg },
];

mkdirSync(out, { recursive: true });

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=/tmp/nextwise-icons',
  '--no-first-run',
  '--hide-scrollbars',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://localhost:${PORT}/json`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error('Chrome did not expose a debugging target');
}

const ws = new WebSocket(await connect());
let id = 0;
const pending = new Map();
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (pending.has(m.id)) pending.get(m.id)(m);
};
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id;
    pending.set(i, (m) => res(m.result ?? {}));
    ws.send(JSON.stringify({ id: i, method, params }));
  });

for (const { name, size, source } of targets) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: size,
    height: size,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const html = `<!doctype html><meta charset="utf-8">
    <style>html,body{margin:0;padding:0;background:transparent}
    svg{display:block;width:${size}px;height:${size}px}</style>${source}`;
  await send('Page.navigate', { url: `data:text/html;base64,${Buffer.from(html).toString('base64')}` });
  await sleep(500);
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(out, name), Buffer.from(data, 'base64'));
  console.log('wrote', `public/icons/${name}`, `(${size}px)`);
}

ws.close();
chrome.kill();
process.exit(0);
