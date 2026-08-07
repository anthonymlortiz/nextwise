import { useEffect, useRef, useState } from 'react';
import type { Situation } from '../types';
import { Button, Card, SectionTitle, TextInput } from '../ui';
import { useChat } from '../chat/useChat';
import type { ChatTransport } from '../chat/client';
import { clearApiKey, getApiKey, isRemembered, looksLikeApiKey, setApiKey } from '../chat/key';

const SUGGESTIONS = [
  'What should I work on?',
  "I've got 20 minutes and I'm fried",
  'Add: draft the Q3 planning doc, deep work, about an hour',
  "What's left on my work projects?",
];

/**
 * The key form is a gate rather than a settings page: without a key the panel
 * can do nothing at all, so there is no point showing a conversation.
 */
function KeyGate({ onSaved }: { onSaved: () => void }) {
  const [value, setValue] = useState('');
  const [remember, setRemember] = useState(false);
  const suspicious = value.trim().length > 0 && !looksLikeApiKey(value);

  return (
    <Card className="p-5">
      <SectionTitle hint="Stored in this browser only">Connect jAIme</SectionTitle>
      <p className="mt-3 text-sm text-mist-400">
        jAIme talks to Claude directly from this page using your own Anthropic API key. There
        is no server in between — the request goes from your browser to your account.
      </p>
      <form
        className="mt-4 grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!value.trim()) return;
          setApiKey(value, remember);
          setValue('');
          onSaved();
        }}
      >
        <TextInput
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="sk-ant-..."
          aria-label="Anthropic API key"
          autoComplete="off"
        />
        {suspicious && (
          <p className="text-xs text-warn">
            Anthropic keys normally start with <code>sk-ant-</code>. Saving anyway is fine if
            you know better.
          </p>
        )}
        <label className="flex cursor-pointer items-center gap-2 text-xs text-mist-400">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
           
          />
          Remember on this device
        </label>
        <p className="text-xs text-mist-400">
          {remember
            ? 'The key will be saved in this browser so you do not have to paste it again. Anyone with access to this profile can read it.'
            : 'The key will be kept in memory only and forgotten when you reload — the same rule the app uses for sync tokens.'}
        </p>
        <div className="flex items-center gap-2">
          <Button type="submit" variant="primary" disabled={!value.trim()}>
            Save key
          </Button>
          <a
            href="https://console.anthropic.com/settings/keys"
            target="_blank"
            rel="noreferrer"
            className="text-xs text-mist-400 underline hover:text-mist-200"
          >
            Get a key
          </a>
        </div>
      </form>
    </Card>
  );
}

export function ChatPanel({
  context,
  setContext,
  transport,
}: {
  context: Situation;
  setContext: (patch: Partial<Situation>) => void;
  transport?: ChatTransport;
}) {
  const [hasKey, setHasKey] = useState(() => !!getApiKey());
  const [draft, setDraft] = useState('');
  const contextRef = useRef(context);
  contextRef.current = context;

  const { entries, busy, send, reset, stop } = useChat({
    transport,
    // Read through a ref so a tool always sees the latest context rather than
    // whatever was current when the conversation started.
    getContext: () => contextRef.current,
    setContext,
  });

  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [entries.length]);

  if (!hasKey) return <KeyGate onSaved={() => setHasKey(true)} />;

  const submit = (text: string) => {
    if (!text.trim() || busy) return;
    send(text);
    setDraft('');
  };

  return (
    <Card className="flex h-[70vh] flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <SectionTitle hint={busy ? 'Thinking…' : 'Ask for anything'}>jAIme</SectionTitle>
        <div className="flex gap-2">
          {busy && <Button onClick={stop}>Stop</Button>}
          {entries.length > 0 && !busy && <Button onClick={reset}>New chat</Button>}
          <Button
            onClick={() => {
              clearApiKey();
              setHasKey(false);
            }}
          >
            {isRemembered() ? 'Forget key' : 'Disconnect'}
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        {entries.length === 0 ? (
          <div className="grid gap-3 py-6 text-center">
            <p className="text-sm text-mist-400">
              Tell jAIme your situation and it will pick something for you — or just say what
              you need to get done.
            </p>
            <div className="mx-auto flex max-w-xl flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => submit(s)}
                  className="rounded-full border border-line bg-raise-1 px-3 py-1.5 text-xs text-mist-200 hover:border-line-strong hover:bg-raise-3"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="grid gap-3">
            {entries.map((entry) => {
              if (entry.role === 'tool') {
                return (
                  <p
                    key={entry.id}
                    className={`flex items-center gap-2 text-xs ${
                      entry.failed ? 'text-warn' : 'text-mist-400'
                    }`}
                  >
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
                    {entry.text}
                  </p>
                );
              }
              if (entry.role === 'error') {
                return (
                  <p
                    key={entry.id}
                    className="rounded-lg border border-rose-400/20 bg-rose-500/10 px-3 py-2 text-xs text-danger"
                  >
                    {entry.text}
                  </p>
                );
              }
              const mine = entry.role === 'user';
              return (
                <div key={entry.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className={`max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm ${
                      mine
                        ? 'bg-accent-500/20 text-fg'
                        : 'border border-line bg-raise-1 text-mist-200'
                    }`}
                  >
                    {entry.text}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <div ref={endRef} />
      </div>

      <form
        className="flex items-center gap-2 border-t border-line px-5 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit(draft);
        }}
      >
        <TextInput
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="What should I work on?"
          aria-label="Message jAIme"
          className="flex-1"
          disabled={busy}
        />
        <Button type="submit" variant="primary" disabled={busy || !draft.trim()}>
          Send
        </Button>
      </form>
    </Card>
  );
}
