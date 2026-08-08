import type { VoiceEngine, VoiceErrorKind, VoiceListener, VoiceSession } from './voice';
import { chunkForSpeech, describeVoiceError } from './voice';

/**
 * Scriptable stand-in for the Web Speech API, in the same spirit as
 * `FakeClaudeTransport` and the sync fakes: headless Chrome has no microphone
 * and no voices, so without this the entire feature would be untestable and
 * would break silently.
 *
 * A test drives it directly — `hear()` to emit a partial transcript, `finish()`
 * to settle one — and reads `spoken` to assert what was said aloud.
 */
export class FakeVoiceEngine implements VoiceEngine {
  /** Every utterance handed to speak(), in order and already chunked. */
  readonly spoken: string[] = [];
  /** How many times speech was cancelled, so "stop" can be asserted. */
  cancelled = 0;
  listening = false;

  private listener: VoiceListener | null = null;
  private supportsListening: boolean;
  private supportsSpeaking: boolean;
  private onDone: (() => void) | undefined;

  constructor({ canListen = true, canSpeak = true } = {}) {
    this.supportsListening = canListen;
    this.supportsSpeaking = canSpeak;
  }

  canListen(): boolean {
    return this.supportsListening;
  }

  canSpeak(): boolean {
    return this.supportsSpeaking;
  }

  listen(listener: VoiceListener): VoiceSession {
    this.listener = listener;
    this.listening = true;
    return {
      stop: () => this.finish(),
      abort: () => {
        this.listening = false;
        this.listener = null;
      },
    };
  }

  /** Emit a partial transcript, as the real engine does while you talk. */
  hear(text: string): void {
    this.listener?.onInterim?.(text);
  }

  /** Settle the transcript and end the session, as releasing the mic does. */
  finish(text?: string): void {
    const listener = this.listener;
    this.listening = false;
    this.listener = null;
    listener?.onFinal(text ?? '');
  }

  /** Fail the session the way a denied permission prompt would. */
  fail(kind: VoiceErrorKind = 'denied'): void {
    const listener = this.listener;
    this.listening = false;
    this.listener = null;
    listener?.onError(kind, describeVoiceError(kind));
  }

  speak(text: string, options?: { onDone?: () => void }): void {
    // Chunked here too, so a test can prove long replies are split rather than
    // handed to the browser as one utterance it would truncate.
    this.spoken.push(...chunkForSpeech(text));
    this.onDone = options?.onDone;
  }

  /** Run the callback the real engine fires when the last utterance ends. */
  endSpeech(): void {
    const done = this.onDone;
    this.onDone = undefined;
    done?.();
  }

  cancelSpeech(): void {
    this.cancelled += 1;
    this.onDone = undefined;
  }
}
