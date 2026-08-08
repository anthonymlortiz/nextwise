/**
 * Speech in and out, behind a seam.
 *
 * This is an interface rather than direct calls to the Web Speech API for two
 * reasons. Headless Chrome has no microphone, so the suites need a stand-in the
 * way the sync engine takes a client instead of reaching for `fetch`. And the
 * transcription backend is not settled: Chrome uploads audio to Google, which
 * is the only place this app talks to a third party the user does not own, so
 * swapping in an on-device model later must not touch anything that calls it.
 *
 * Note that the Anthropic Messages API cannot help here — it accepts text and
 * images, not audio — so the chat key buys nothing for speech.
 */

export type VoiceErrorKind =
  | 'denied'
  | 'no-speech'
  | 'no-microphone'
  | 'network'
  | 'other';

export interface VoiceListener {
  /** Fired repeatedly with the best transcript so far, including partial words. */
  onInterim?(text: string): void;
  /** Fired once when listening ends, with everything the engine settled on. */
  onFinal(text: string): void;
  onError(kind: VoiceErrorKind, message: string): void;
}

export interface VoiceSession {
  /** Stop listening and keep what was heard. */
  stop(): void;
  /** Stop listening and discard it. */
  abort(): void;
}

export interface VoiceEngine {
  canListen(): boolean;
  canSpeak(): boolean;
  listen(listener: VoiceListener, options?: { lang?: string }): VoiceSession;
  speak(text: string, options?: { onDone?: () => void }): void;
  cancelSpeech(): void;
}

/**
 * Messages are written for someone who wants to fix the problem, not for
 * someone debugging the API. `aborted` is deliberately absent: it is what the
 * browser reports when the user presses stop, and reporting that back as an
 * error would turn every normal use into a red message.
 */
const ERROR_MESSAGES: Record<VoiceErrorKind, string> = {
  denied: 'Microphone access is blocked. Allow it for this site in your browser settings.',
  'no-speech': "Didn't catch anything. Try again a little closer to the mic.",
  'no-microphone': 'No microphone was found.',
  network: 'The speech service could not be reached.',
  other: 'Speech recognition failed.',
};

function classify(error: string): VoiceErrorKind {
  if (error === 'not-allowed' || error === 'service-not-allowed') return 'denied';
  if (error === 'no-speech') return 'no-speech';
  if (error === 'audio-capture') return 'no-microphone';
  if (error === 'network') return 'network';
  return 'other';
}

export function describeVoiceError(kind: VoiceErrorKind): string {
  return ERROR_MESSAGES[kind];
}

/**
 * Chrome stops speaking part way through a long utterance — a long-standing
 * bug with no reliable workaround other than not producing long utterances. So
 * a reply is queued as several short ones, split on sentence boundaries so the
 * pauses land where a reader would put them anyway. It also makes stopping
 * responsive, since cancelling only has to interrupt the current fragment.
 */
const CHUNK_TARGET = 180;

export function chunkForSpeech(text: string): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];

  const sentences = clean.match(/[^.!?]+[.!?]*\s*/g) ?? [clean];
  const chunks: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    // A single sentence longer than the target still has to be broken up, or
    // the bug this exists to avoid comes back on one very long line.
    if (sentence.length > CHUNK_TARGET) {
      if (current.trim()) chunks.push(current.trim());
      current = '';
      const words = sentence.split(' ');
      let line = '';
      for (const word of words) {
        if ((line + ' ' + word).trim().length > CHUNK_TARGET) {
          if (line.trim()) chunks.push(line.trim());
          line = word;
        } else {
          line = line ? `${line} ${word}` : word;
        }
      }
      if (line.trim()) chunks.push(line.trim());
      continue;
    }

    if ((current + sentence).length > CHUNK_TARGET && current.trim()) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}

type RecognitionCtor = new () => SpeechRecognitionLike;

function recognitionCtor(): RecognitionCtor | undefined {
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export const webSpeechEngine: VoiceEngine = {
  canListen: () => !!recognitionCtor(),

  canSpeak: () => typeof window !== 'undefined' && 'speechSynthesis' in window,

  listen(listener, options) {
    const Ctor = recognitionCtor();
    if (!Ctor) {
      listener.onError('other', 'This browser cannot listen.');
      return { stop() {}, abort() {} };
    }

    const recognition = new Ctor();
    recognition.lang = options?.lang ?? navigator.language ?? 'en-US';
    recognition.interimResults = true;
    // The user decides when they have finished talking. Left to itself the
    // engine cuts off at the first pause, which loses the second half of any
    // sentence that needed a moment's thought.
    recognition.continuous = true;

    let settled = '';
    let failed = false;
    let discarded = false;

    recognition.onresult = (event) => {
      let pending = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = result[0]?.transcript ?? '';
        if (result.isFinal) settled += text;
        else pending += text;
      }
      listener.onInterim?.(`${settled}${pending}`.trim());
    };

    recognition.onerror = (event) => {
      // Pressing stop surfaces as `aborted`; that is the feature working.
      if (event.error === 'aborted') return;
      failed = true;
      const kind = classify(event.error);
      listener.onError(kind, describeVoiceError(kind));
    };

    recognition.onend = () => {
      if (failed || discarded) return;
      listener.onFinal(settled.trim());
    };

    try {
      recognition.start();
    } catch {
      // Starting twice throws; treat it as nothing to do rather than an error
      // the user has to read.
    }

    return {
      stop: () => recognition.stop(),
      abort: () => {
        discarded = true;
        recognition.abort();
      },
    };
  },

  speak(text, options) {
    if (!this.canSpeak()) return;
    const chunks = chunkForSpeech(text);
    if (!chunks.length) {
      options?.onDone?.();
      return;
    }
    window.speechSynthesis.cancel();
    chunks.forEach((chunk, index) => {
      const utterance = new SpeechSynthesisUtterance(chunk);
      if (index === chunks.length - 1 && options?.onDone) {
        utterance.onend = () => options.onDone?.();
      }
      window.speechSynthesis.speak(utterance);
    });
  },

  cancelSpeech() {
    if (this.canSpeak()) window.speechSynthesis.cancel();
  },
};

/**
 * Whether replies are read aloud. Stored rather than defaulted on, because an
 * assistant that starts talking in a quiet office without being asked is a
 * setting people turn off once and never trust again.
 */
const PREF_KEY = 'pp.voice.v1';

interface VoicePrefs {
  speak: boolean;
}

export function loadVoicePrefs(): VoicePrefs {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return { speak: false };
    const parsed = JSON.parse(raw) as Partial<VoicePrefs>;
    return { speak: parsed.speak === true };
  } catch {
    return { speak: false };
  }
}

export function setSpeakReplies(on: boolean): void {
  localStorage.setItem(PREF_KEY, JSON.stringify({ speak: on }));
}
