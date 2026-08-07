export async function connect(port = 9224, url = process.env.TEST_URL ?? 'http://localhost:5174/') {
  const targets = await (await fetch(`http://localhost:${port}/json`)).json();
  const page = targets.find(t => t.type === 'page' && !t.url.startsWith('chrome-extension'));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); const errors = [];
  const send = (m, p = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') errors.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').split('\n')[0]);
  };
  await new Promise(r => ws.onopen = r);
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url });
  await new Promise(r => setTimeout(r, 4000));
  const js = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const ex = r.exceptionDetails.exception;
      throw new Error(ex?.description || ex?.value?.message || ex?.value?.name || JSON.stringify(ex?.preview?.properties || r.exceptionDetails.text));
    }
    return r.result.value;
  };
  return { js, errors, url, close: () => ws.close(), send };
}

export function reporter() {
  let pass = 0, fail = 0;
  return {
    ok(name, cond, extra = '') {
      if (cond) {
        pass++;
        console.log('  PASS', name);
      } else {
        fail++;
        console.log('  FAIL', name, extra);
      }
    },
    section(t) { console.log('\n' + t); },
    done(errors = []) {
      console.log(`\n=== ${pass} passed, ${fail} failed | runtime errors: ${errors.length} ===`);
      errors.forEach(e => console.log('   ', e));
      return fail === 0 && errors.length === 0;
    },
  };
}
