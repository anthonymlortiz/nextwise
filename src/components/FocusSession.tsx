import { useEffect, useRef, useState } from 'react';
import type { ChecklistItem, Project, Task } from '../types';
import { CONTEXT_LABEL, CONTEXT_SHORT } from '../types';
import {
  EXTEND_MIN,
  checklistProgress,
  clockLabel,
  isOvertime,
  newChecklistItem,
  progress,
  type FocusSession,
} from '../session';
import { Button, Dot, Linkified, SectionTitle, TextInput } from '../ui';
import { FOCUS_DOT, PRIORITY_TEXT, formatMinutes } from '../styles';

/**
 * How often the clock face is recomputed. Elapsed time is always derived from
 * wall-clock stamps, so a throttled or skipped tick costs a repaint, never
 * accuracy.
 */
const TICK_MS = 1000;

type StuckChoice = 'menu' | 'blocked' | null;

function Checklist({
  items,
  onChange,
  inputRef,
}: {
  items: ChecklistItem[];
  onChange: (items: ChecklistItem[]) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const [draft, setDraft] = useState('');

  const add = () => {
    const text = draft.trim();
    if (!text) return;
    onChange([...items, newChecklistItem(text)]);
    setDraft('');
  };

  return (
    <div className="grid gap-1">
      {items.map((item) => (
        <div
          key={item.id}
          data-checklist-item={item.done ? 'done' : 'todo'}
          className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-raise-1"
        >
          <button
            onClick={() =>
              onChange(items.map((i) => (i.id === item.id ? { ...i, done: !i.done } : i)))
            }
            aria-label={item.done ? `Undo ${item.text}` : `Finish ${item.text}`}
            className={`flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-[5px] border transition-all duration-150 ${
              item.done
                ? 'border-emerald-400/40 bg-emerald-500/25 text-good'
                : 'border-line-strong hover:border-accent-400 hover:bg-accent-500/15'
            }`}
          >
            {item.done && (
              <svg viewBox="0 0 12 12" className="h-2.5 w-2.5 fill-current">
                <path d="M4.6 8.4L2.2 6l-.8.8 3.2 3.2 6-6-.8-.8z" />
              </svg>
            )}
          </button>
          <span
            className={`min-w-0 flex-1 break-words text-sm ${
              item.done ? 'text-mist-500 line-through' : 'text-mist-200'
            }`}
          >
            {item.text}
          </span>
          <button
            onClick={() => onChange(items.filter((i) => i.id !== item.id))}
            aria-label={`Remove ${item.text}`}
            className="reveal tap shrink-0 rounded-md px-1.5 py-0.5 text-xs text-mist-500 transition-opacity hover:bg-raise-3 hover:text-fg"
          >
            ×
          </button>
        </div>
      ))}

      <div className="mt-1 flex gap-2">
        <TextInput
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          placeholder="Add a step…"
          className="flex-1"
          aria-label="Add a checklist step"
        />
        <Button onClick={add} disabled={!draft.trim()}>
          Add
        </Button>
      </div>
    </div>
  );
}

export function FocusSessionView({
  session,
  task,
  project,
  smaller,
  onPauseToggle,
  onExtend,
  onComplete,
  onExit,
  onBlocked,
  onSwap,
  onChecklistChange,
}: {
  session: FocusSession;
  task: Task;
  project?: Project;
  /** The best-scoring shorter task, offered when the current one is too big. */
  smaller?: Task;
  onPauseToggle: () => void;
  onExtend: () => void;
  onComplete: () => void;
  onExit: () => void;
  onBlocked: (note: string) => void;
  onSwap: (next: Task) => void;
  onChecklistChange: (items: ChecklistItem[]) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [stuck, setStuck] = useState<StuckChoice>(null);
  const [waitingOn, setWaitingOn] = useState('');
  const checklistInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (session.paused) return;
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [session.paused]);

  // A pause, an extension or a resume all change the face immediately rather
  // than at the next tick, which would otherwise look like a dropped click.
  useEffect(() => {
    setNow(Date.now());
  }, [session.paused, session.plannedMin, session.runStartedAt]);

  // A swap replaces the task under the same mounted component, so the menu that
  // triggered it has to be dismissed explicitly or it hangs over the new task.
  useEffect(() => {
    setStuck(null);
    setWaitingOn('');
  }, [session.taskId]);

  const over = isOvertime(session, now);
  const items = task.checklist ?? [];
  const { done: doneCount, total } = checklistProgress(items);
  const priorSpent = task.spentMin ?? 0;

  const breakItDown = () => {
    setStuck(null);
    checklistInput.current?.focus();
  };

  return (
    <div data-session="" className="mx-auto grid max-w-2xl gap-7 py-4 sm:py-8">
      <div className="flex items-center justify-between gap-4">
        <span className="text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-mist-500">
          {session.paused ? 'Paused' : 'In focus'}
        </span>
        <button
          onClick={onExit}
          className="rounded-lg px-2.5 py-1 text-xs text-mist-400 transition-colors hover:bg-raise-2 hover:text-fg"
        >
          Leave session
        </button>
      </div>

      <div>
        <h2
          data-session-task={task.title}
          className="text-[1.75rem] font-semibold leading-tight tracking-tight text-fg"
        >
          <Linkified text={task.title} />
        </h2>
        <div className="mt-2.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-mist-400">
          <span className={`font-semibold ${PRIORITY_TEXT[task.priority]}`}>P{task.priority}</span>
          <span aria-hidden="true" className="text-mist-500/50">·</span>
          <span className="tnum">{formatMinutes(task.estimateMin)}</span>
          <span aria-hidden="true" className="text-mist-500/50">·</span>
          <span className="inline-flex items-center gap-1">
            <Dot className={FOCUS_DOT[task.focusLevel]} />
            {task.focusLevel}
          </span>
          {task.context && (
            <>
              <span aria-hidden="true" className="text-mist-500/50">·</span>
              <span title={CONTEXT_LABEL[task.context]}>@{CONTEXT_SHORT[task.context]}</span>
            </>
          )}
          {project && (
            <>
              <span aria-hidden="true" className="text-mist-500/50">·</span>
              <span className="inline-flex items-center gap-1 text-mist-300">
                <Dot style={{ backgroundColor: project.color }} />
                {project.name}
              </span>
            </>
          )}
        </div>
      </div>

      <div>
        <div
          data-session-clock={over ? 'over' : 'under'}
          className={`tnum text-center text-[4rem] font-semibold leading-none tracking-tight tabular-nums sm:text-[5rem] ${
            over ? 'text-warn' : 'text-fg'
          } ${session.paused ? 'opacity-50' : ''}`}
        >
          {clockLabel(session, now)}
        </div>
        <div className="mt-4 h-1 overflow-hidden rounded-full bg-raise-2">
          <div
            data-session-progress={Math.round(progress(session, now) * 100)}
            className={`h-full rounded-full transition-[width] duration-500 ${
              over ? 'bg-warn/70' : 'bg-accent-400/70'
            }`}
            style={{ width: `${progress(session, now) * 100}%` }}
          />
        </div>
        <p className="mt-2.5 text-center text-xs text-mist-500">
          {over ? 'over' : 'left of'} {formatMinutes(session.plannedMin)}
          {session.extensions > 0 &&
            ` · extended ${session.extensions}×`}
          {priorSpent > 0 && ` · ${formatMinutes(priorSpent)} spent before today`}
        </p>
      </div>

      {task.notes && (
        <div>
          <SectionTitle>Notes and links</SectionTitle>
          <p className="mt-2.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-mist-300">
            <Linkified text={task.notes} />
          </p>
        </div>
      )}

      <div>
        <SectionTitle hint={total > 0 ? `${doneCount}/${total}` : undefined}>Checklist</SectionTitle>
        <div className="mt-2.5">
          <Checklist items={items} onChange={onChecklistChange} inputRef={checklistInput} />
        </div>
      </div>

      <div className="grid gap-3 border-t border-line-soft pt-6">
        {/* Two groups rather than one wrapping row: a flex spacer between the
            primary and secondary controls strands the last button on its own
            line once the row wraps, which is exactly what happens on a phone. */}
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="flex gap-2">
            <Button variant="primary" onClick={onComplete} className="px-5 py-2">
              Complete
            </Button>
            <Button onClick={onPauseToggle} className="px-5 py-2">
              {session.paused ? 'Resume' : 'Pause'}
            </Button>
          </div>
          <span className="hidden flex-1 sm:block" />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="subtle"
              onClick={() => setStuck(stuck ? null : 'menu')}
              aria-expanded={stuck !== null}
            >
              I&rsquo;m stuck
            </Button>
            <Button variant="subtle" onClick={onExtend}>
              This is taking longer
            </Button>
          </div>
        </div>

        {stuck === 'menu' && (
          <div data-stuck-menu="" className="grid gap-1 rounded-xl border border-line bg-raise-1 p-2">
            <button
              onClick={() => setStuck('blocked')}
              className="rounded-lg px-3 py-2 text-left text-sm text-mist-200 transition-colors hover:bg-raise-2"
            >
              Mark it blocked
              <span className="mt-0.5 block text-xs text-mist-500">
                Park it until whatever you&rsquo;re waiting on moves.
              </span>
            </button>
            <button
              onClick={breakItDown}
              className="rounded-lg px-3 py-2 text-left text-sm text-mist-200 transition-colors hover:bg-raise-2"
            >
              Break it down
              <span className="mt-0.5 block text-xs text-mist-500">
                Stay here and write the smallest next step.
              </span>
            </button>
            <button
              onClick={() => smaller && onSwap(smaller)}
              disabled={!smaller}
              className="rounded-lg px-3 py-2 text-left text-sm text-mist-200 transition-colors hover:bg-raise-2 disabled:cursor-not-allowed disabled:text-mist-500 disabled:hover:bg-transparent"
            >
              Something smaller
              <span className="mt-0.5 block text-xs text-mist-500">
                {smaller
                  ? `Bank this time and switch to “${smaller.title}”.`
                  : 'Nothing shorter is available right now.'}
              </span>
            </button>
          </div>
        )}

        {stuck === 'blocked' && (
          <div data-stuck-blocked="" className="grid gap-2 rounded-xl border border-line bg-raise-1 p-3">
            <span className="text-xs text-mist-400">What are you waiting on?</span>
            <div className="flex gap-2">
              <TextInput
                autoFocus
                value={waitingOn}
                onChange={(e) => setWaitingOn(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && waitingOn.trim()) onBlocked(waitingOn.trim());
                }}
                placeholder="Dana's reply, a delivery…"
                className="flex-1"
                aria-label="What are you waiting on"
              />
              <Button
                variant="primary"
                onClick={() => onBlocked(waitingOn.trim())}
                disabled={!waitingOn.trim()}
              >
                Park it
              </Button>
              <Button variant="subtle" onClick={() => setStuck('menu')}>
                Back
              </Button>
            </div>
          </div>
        )}

        <p className="text-[11px] leading-relaxed text-mist-500">
          {session.paused
            ? 'The clock is stopped. Time already spent is kept.'
            : `Leaving banks the time you\u2019ve spent. “Taking longer” adds ${EXTEND_MIN} minutes and raises the estimate.`}
        </p>
      </div>
    </div>
  );
}
