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

const clickSel = (selector) => js(`(()=>{
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) throw new Error('no element: ' + ${JSON.stringify(selector)});
  el.click(); return 'ok';
})()`);

const type = (selector, value) => js(`(()=>{
  const i = document.querySelector(${JSON.stringify(selector)});
  if (!i) throw new Error('no input: ' + ${JSON.stringify(selector)});
  const proto = i.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto,'value').set.call(i, ${JSON.stringify(value)});
  i.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';
})()`);

const draft = () => js(`document.querySelector('[aria-label="Message jAIme"]').value`);
const spoken = () => js(`window.__fbVoiceEngine.spoken`);

// App only reads the injected globals while it renders, and the chat tab is
// mounted conditionally — so leaving and re-entering is what picks a fake up.
const install = (voiceOpts = '{}', script = '') => js(`(() => {
  window.__fbVoiceEngine = new window.__fb.FakeVoiceEngine(${voiceOpts});
  ${script}
  return 'installed';
})()`);

const enterTab = async () => {
  await click('Focus');
  await wait(200);
  await click('jAIme');
  await wait(400);
};

// The panel is gated on a key, and every suite starts with a fresh page, so the
// memory-only default would put a form where the composer should be. Persisted
// here purely so §8's reload survives it; cleared again at the end.
await js(`(() => {
  window.__fb.chatKey.setApiKey('sk-ant-voicetest', true);
  localStorage.removeItem('pp.voice.v1');
  return 'ok';
})()`);

r.section('1. Long replies are chunked');
eq('a short reply stays one utterance',
  await js(`window.__fb.voice.chunkForSpeech('Do the design doc next.')`),
  ['Do the design doc next.']);
eq('nothing to say speaks nothing', await js(`window.__fb.voice.chunkForSpeech('   ')`), []);
eq('a long reply is split rather than truncated by Chrome', await js(`(() => {
  const parts = window.__fb.voice.chunkForSpeech('This sentence carries a little weight. '.repeat(12));
  return parts.length > 1 && parts.every(p => p.length <= 180);
})()`), true);
eq('one enormous sentence is broken up too', await js(`(() => {
  const parts = window.__fb.voice.chunkForSpeech('word '.repeat(200));
  return parts.length > 1 && parts.every(p => p.length <= 180);
})()`), true);
eq('chunking loses no words', await js(`(() => {
  const src = 'This sentence carries a little weight. '.repeat(12);
  const clean = src.replace(/\\s+/g, ' ').trim();
  return window.__fb.voice.chunkForSpeech(src).join(' ') === clean;
})()`), true);
eq('speech is off until asked for', await js(`window.__fb.voice.loadVoicePrefs().speak`), false);

r.section('2. Controls follow what the browser can do');
await install(`{ canListen: false, canSpeak: false }`);
await enterTab();
eq('the panel is past the key gate',
  await js(`!!document.querySelector('[aria-label="Message jAIme"]')`), true);
eq('no mic when the browser cannot listen',
  await js(`!document.querySelector('[data-voice-mic]')`), true);
eq('no speaker when the browser cannot speak',
  await js(`!document.querySelector('[data-voice-speak]')`), true);

await install();
await enterTab();
eq('mic appears when supported', await js(`!!document.querySelector('[data-voice-mic]')`), true);
eq('speaker appears when supported', await js(`!!document.querySelector('[data-voice-speak]')`), true);
eq('reading aloud starts off',
  await js(`document.querySelector('[data-voice-speak]').dataset.voiceSpeak`), 'off');

r.section('3. Dictation fills the composer');
await clickSel('[data-voice-mic]');
await wait(200);
eq('the mic shows it is listening',
  await js(`document.querySelector('[data-voice-mic]').dataset.voiceState`), 'listening');
eq('the engine really was asked to listen', await js(`window.__fbVoiceEngine.listening`), true);
eq('sending audio away is disclosed while it happens',
  await js(`/audio is sent to your browser/i.test(document.querySelector('[data-voice-note]').innerText)`),
  true);

await js(`window.__fbVoiceEngine.hear('book the'); 'ok'`);
await wait(150);
eq('a partial transcript shows immediately', await draft(), 'book the');
await js(`window.__fbVoiceEngine.hear('book the dentist'); 'ok'`);
await wait(150);
eq('it keeps up as you talk', await draft(), 'book the dentist');

await js(`window.__fbVoiceEngine.finish('book the dentist tomorrow'); 'ok'`);
await wait(200);
eq('the settled transcript lands in the composer', await draft(), 'book the dentist tomorrow');
eq('listening ends with it',
  await js(`document.querySelector('[data-voice-mic]').dataset.voiceState`), 'idle');
// The whole point of filling the composer rather than sending: it is reviewable.
eq('nothing was sent without pressing Send',
  await js(`document.body.innerText.includes('book the dentist tomorrow')`), false);

await clickSel('[data-voice-mic]');
await wait(150);
await js(`window.__fbVoiceEngine.finish(''); 'ok'`);
await wait(200);
eq('hearing nothing leaves the draft alone', await draft(), 'book the dentist tomorrow');

r.section('4. Dictation adds to what was typed');
await type('[aria-label="Message jAIme"]', 'add task:');
await wait(150);
await clickSel('[data-voice-mic]');
await wait(150);
await js(`window.__fbVoiceEngine.hear('call'); 'ok'`);
await wait(150);
eq('the typed part survives an interim result', await draft(), 'add task: call');
await js(`window.__fbVoiceEngine.finish('call the plumber'); 'ok'`);
await wait(200);
eq('speech is appended, not pasted over the typing', await draft(), 'add task: call the plumber');

r.section('5. A refused microphone says so');
await clickSel('[data-voice-mic]');
await wait(150);
await js(`window.__fbVoiceEngine.fail('denied'); 'ok'`);
await wait(250);
eq('the refusal is on screen, not swallowed',
  await js(`document.querySelector('[data-voice-error]').innerText`),
  'Microphone access is blocked. Allow it for this site in your browser settings.');
eq('the mic returns to idle',
  await js(`document.querySelector('[data-voice-mic]').dataset.voiceState`), 'idle');
eq('the draft is left intact', await draft(), 'add task: call the plumber');

r.section('6. Replies are read aloud only when asked');
await install(`{}`, `
  const fake = new window.__fb.FakeClaudeTransport();
  fake.say('Start with the migration doc. It is the only deep work that fits.');
  fake.say('Book the dentist. It only takes five minutes.');
  window.__fbChatTransport = fake;
`);
await enterTab();
await type('[aria-label="Message jAIme"]', 'what next?');
await wait(150);
await click('Send');
await wait(900);
eq('the reply arrived',
  await js(`document.body.innerText.includes('Start with the migration doc')`), true);
eq('and stayed silent, because speech is off', await js(`window.__fbVoiceEngine.spoken.length`), 0);

await clickSel('[data-voice-speak]');
await wait(250);
eq('switching it on now says so',
  await js(`document.querySelector('[data-voice-speak]').dataset.voiceSpeak`), 'on');
// Regression: the marker used to stand still while speech was off, so turning
// it on read the entire conversation from the beginning.
eq('switching it on does not recite the backlog',
  await js(`window.__fbVoiceEngine.spoken.length`), 0);

await type('[aria-label="Message jAIme"]', 'and after that?');
await wait(150);
await click('Send');
await wait(900);
eq('the next reply is spoken', await spoken(), ['Book the dentist. It only takes five minutes.']);
eq('the question was not spoken back at me',
  await js(`window.__fbVoiceEngine.spoken.some(s => s.includes('and after that'))`), false);
eq('a stop control appears while it talks',
  await js(`!!document.querySelector('[data-voice-stop-speaking]')`), true);
// A delta, not an absolute: StrictMode runs the mount effect's cleanup once, so
// the engine has legitimately been told to cancel before any of this.
const cancelsBefore = await js(`window.__fbVoiceEngine.cancelled`);
await clickSel('[data-voice-stop-speaking]');
await wait(200);
eq('stopping really cancels the speech',
  (await js(`window.__fbVoiceEngine.cancelled`)) - cancelsBefore, 1);
eq('and the stop control goes away',
  await js(`!document.querySelector('[data-voice-stop-speaking]')`), true);

// Leaving the tab has to shut it up too: speech outlives the component that
// started it, so without this the assistant carries on talking to a closed tab.
const cancelsOnLeave = await js(`window.__fbVoiceEngine.cancelled`);
await click('Focus');
await wait(250);
eq('leaving the tab stops the talking',
  (await js(`window.__fbVoiceEngine.cancelled`)) > cancelsOnLeave, true);

r.section('7. Only prose is spoken');
await install(`{}`, `
  const fake = new window.__fb.FakeClaudeTransport();
  fake.callTool('list_tasks', { search: 'dentist' });
  fake.say('One left.');
  window.__fbChatTransport = fake;
`);
await enterTab();
await type('[aria-label="Message jAIme"]', 'how many?');
await wait(150);
await click('Send');
await wait(1200);
eq('the tool step is visible',
  await js(`document.body.innerText.includes('Read your tasks')`), true);
eq('but bookkeeping is not read out', await spoken(), ['One left.']);

await install(`{}`, `
  const fake = new window.__fb.FakeClaudeTransport();
  fake.failWith = 'That API key was rejected. Check it and try again.';
  window.__fbChatTransport = fake;
`);
await enterTab();
await type('[aria-label="Message jAIme"]', 'anything?');
await wait(150);
await click('Send');
await wait(900);
eq('the error is shown',
  await js(`document.body.innerText.includes('That API key was rejected')`), true);
eq('and never spoken', await js(`window.__fbVoiceEngine.spoken.length`), 0);

r.section('8. The choice survives a reload');
eq('the preference was written', await js(`window.__fb.voice.loadVoicePrefs().speak`), true);
await t.send('Page.navigate', { url: t.url });
await wait(2500);
await install();
await enterTab();
eq('reading aloud is still on',
  await js(`document.querySelector('[data-voice-speak]').dataset.voiceSpeak`), 'on');
await clickSel('[data-voice-speak]');
await wait(200);
eq('turning it off is remembered too', await js(`window.__fb.voice.loadVoicePrefs().speak`), false);

r.section('9. Usable on a phone');
// A real 390px coarse-pointer viewport. Headless Chrome reports a fine pointer
// even with device metrics overridden, so the emulated media query matters as
// much as the size.
await t.send('Emulation.setDeviceMetricsOverride', {
  width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
});
await t.send('Emulation.setTouchEmulationEnabled', { enabled: true });
await t.send('Emulation.setEmulatedMedia', {
  features: [{ name: 'hover', value: 'none' }, { name: 'pointer', value: 'coarse' }],
});
await wait(400);
eq('the viewport really is a phone',
  await js(`[innerWidth, matchMedia('(hover: none) and (pointer: coarse)').matches]`), [390, true]);

eq('the mic is not hidden behind hover',
  await js(`getComputedStyle(document.querySelector('[data-voice-mic]')).opacity`), '1');
eq('the mic has a finger-sized hit area',
  await js(`document.querySelector('[data-voice-mic]').classList.contains('tap')`), true);
eq('the speaker toggle does too',
  await js(`document.querySelector('[data-voice-speak]').classList.contains('tap')`), true);
eq('both controls are labelled', await js(`(() => {
  const mic = document.querySelector('[data-voice-mic]');
  const speak = document.querySelector('[data-voice-speak]');
  return !!mic.getAttribute('aria-label') && !!speak.getAttribute('aria-label');
})()`), true);

// Regression: the composer used to be a single-line input sharing its row with
// the mic, the speaker and Send, leaving it 159px wide. A dictated sentence
// showed three words of twenty-one, so "read it back before sending" — the
// entire reason dictation fills the composer instead of sending — was
// impossible on the one device this app is mostly used from.
const LONG = 'book the dentist for next tuesday afternoon and also remind me to send Dana the revised quarterly figures before the review';
await clickSel('[data-voice-mic]');
await wait(150);
await js(`window.__fbVoiceEngine.finish(${JSON.stringify(LONG)}); 'ok'`);
await wait(400);
eq('the whole dictated message is in the box', await draft(), LONG);
eq('and every word of it is actually visible', await js(`(() => {
  const el = document.querySelector('[aria-label="Message jAIme"]');
  return el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1;
})()`), true);
eq('the composer grew to several lines rather than scrolling sideways', await js(`(() => {
  const el = document.querySelector('[aria-label="Message jAIme"]');
  const line = parseFloat(getComputedStyle(el).lineHeight) || 20;
  return el.getBoundingClientRect().height > line * 2;
})()`), true);
eq('the page still does not scroll sideways',
  await js(`document.documentElement.scrollWidth <= innerWidth`), true);

// A very long message has to stop growing and scroll, or it eats the transcript.
await type('[aria-label="Message jAIme"]', LONG.repeat(6));
await wait(400);
eq('but it stops growing before it swallows the conversation', await js(`(() => {
  const el = document.querySelector('[aria-label="Message jAIme"]');
  const card = el.closest('[class*="h-["]') ?? document.body;
  return el.getBoundingClientRect().height <= 161
    && el.getBoundingClientRect().height < card.getBoundingClientRect().height / 2;
})()`), true);
eq('and scrolls instead', await js(`(() => {
  const el = document.querySelector('[aria-label="Message jAIme"]');
  return el.scrollHeight > el.clientHeight;
})()`), true);

await type('[aria-label="Message jAIme"]', '');
await t.send('Emulation.clearDeviceMetricsOverride');
await t.send('Emulation.setTouchEmulationEnabled', { enabled: false });
await t.send('Emulation.setEmulatedMedia', { features: [] });
await wait(200);

// Leave the key as the other suites expect to find it: nowhere.
await js(`window.__fb.chatKey.clearApiKey(); localStorage.removeItem('pp.voice.v1'); 'ok'`);

const passed = r.done(t.errors);
t.close();
process.exit(passed ? 0 : 1);
