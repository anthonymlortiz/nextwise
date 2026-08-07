import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  MONTHS,
  WEEKDAYS,
  addDays,
  addMonths,
  formatDate,
  fromISODate,
  isValidISODate,
  monthGrid,
  nextWeekday,
  relativeLabel,
  todayISO,
} from '../dates';

/**
 * A calendar popover for due dates.
 *
 * `<input type="date">` already has a picker, but it hides behind a small icon
 * at the edge of the field, renders in the browser's own light theme against
 * this dark UI, and differs between browsers. This is a plain month grid with
 * the shortcuts people actually reach for.
 */
const QUICK_PICKS: { label: string; resolve: (now: Date) => string }[] = [
  { label: 'Today', resolve: (now) => todayISO(now) },
  { label: 'Tomorrow', resolve: (now) => addDays(todayISO(now), 1) },
  { label: 'This weekend', resolve: (now) => nextWeekday(6, now) },
  { label: 'Next Monday', resolve: (now) => nextWeekday(1, now) },
  { label: 'In a week', resolve: (now) => addDays(todayISO(now), 7) },
];

export function DatePicker({
  value,
  onChange,
  id,
  placeholder = 'No due date',
  label = 'Choose a due date',
}: {
  value?: string;
  onChange: (iso: string | undefined) => void;
  id?: string;
  /** Shown when nothing is picked; the field is reused for "not before" dates. */
  placeholder?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(() => value ?? todayISO());
  const [dropUp, setDropUp] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const today = todayISO();

  // Reopening on a task that already has a date should land on that month.
  useEffect(() => {
    if (open) setCursor(value && isValidISODate(value) ? value : todayISO());
  }, [open, value]);

  // The due-date field sits near the bottom of the task dialog, so a calendar
  // that always dropped downwards spilled past the dialog's edge onto the
  // backdrop. Measure against the enclosing form when there is one — the
  // viewport alone reports plenty of room and misses the real boundary.
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = wrapRef.current?.getBoundingClientRect();
    const height = popRef.current?.offsetHeight ?? 0;
    if (!trigger) return;
    const panel = wrapRef.current?.closest('form')?.getBoundingClientRect();
    const bottomLimit = Math.min(window.innerHeight, panel?.bottom ?? Infinity);
    const topLimit = Math.max(0, panel?.top ?? 0);
    const roomBelow = bottomLimit - trigger.bottom;
    const roomAbove = trigger.top - topLimit;
    setDropUp(roomBelow < height + 12 && roomAbove > roomBelow);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Consume it in the capture phase so the surrounding form's own Escape
      // handler doesn't discard the whole draft. First Escape closes the
      // calendar, a second one closes the form.
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const view = fromISODate(cursor);
  const viewYear = view.getFullYear();
  const viewMonth = view.getMonth();
  const weeks = useMemo(() => monthGrid(viewYear, viewMonth), [viewYear, viewMonth]);

  const choose = (iso: string) => {
    onChange(iso);
    setOpen(false);
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        id={id}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-lg border border-line bg-ink-900/60 px-3 py-2 text-left text-sm text-fg transition-colors hover:border-line-strong"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4 shrink-0 fill-mist-500">
          <path d="M5 1v1h6V1h2v1h1a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h1V1h2zM2 6v8h12V6H2z" />
        </svg>
        {value ? (
          <>
            <span>{formatDate(value)}</span>
            <span className="text-xs text-mist-500">{relativeLabel(value)}</span>
          </>
        ) : (
          <span className="text-mist-500">{placeholder}</span>
        )}
      </button>

      {open && (
        <div
          ref={popRef}
          role="dialog"
          aria-label={label}
          className={`absolute left-0 z-30 w-[18.5rem] rounded-xl border border-line bg-ink-800 p-3 elev-pop ${
            dropUp ? 'bottom-full mb-2' : 'top-full mt-2'
          }`}
        >
          <div className="mb-2 flex flex-wrap gap-1">
            {QUICK_PICKS.map((pick) => (
              <button
                key={pick.label}
                type="button"
                onClick={() => choose(pick.resolve(new Date()))}
                className="rounded-md border border-line bg-raise-1 px-2 py-[3px] text-[11px] font-medium text-mist-300 transition-colors hover:border-line-strong hover:bg-raise-2 hover:text-fg"
              >
                {pick.label}
              </button>
            ))}
          </div>

          <div className="mb-1 flex items-center justify-between">
            <button
              type="button"
              aria-label="Previous month"
              onClick={() => setCursor(addMonths(cursor, -1))}
              className="rounded-md px-2 py-1 text-mist-400 transition-colors hover:bg-raise-3 hover:text-fg"
            >
              ‹
            </button>
            <span data-month-label className="text-sm font-medium text-fg">
              {MONTHS[viewMonth]} {viewYear}
            </span>
            <button
              type="button"
              aria-label="Next month"
              onClick={() => setCursor(addMonths(cursor, 1))}
              className="rounded-md px-2 py-1 text-mist-400 transition-colors hover:bg-raise-3 hover:text-fg"
            >
              ›
            </button>
          </div>

          <div className="grid grid-cols-7 gap-0.5 text-center">
            {WEEKDAYS.map((day) => (
              <span key={day} className="py-1 text-[0.65rem] font-medium uppercase tracking-wide text-mist-500">
                {day[0]}
              </span>
            ))}
            {weeks.flat().map((iso) => {
              const date = fromISODate(iso);
              const outside = date.getMonth() !== viewMonth;
              const selected = iso === value;
              const isToday = iso === today;
              return (
                <button
                  key={iso}
                  type="button"
                  aria-label={iso}
                  aria-current={isToday ? 'date' : undefined}
                  onClick={() => choose(iso)}
                  className={`tnum rounded-md py-1 text-sm transition-colors ${
                    selected
                      ? 'bg-accent-500 font-semibold text-white'
                      : outside
                        ? 'text-mist-500/40 hover:bg-raise-2'
                        : 'text-mist-200 hover:bg-raise-2'
                  } ${isToday && !selected ? 'ring-1 ring-inset ring-accent-400/60' : ''}`}
                >
                  {date.getDate()}
                </button>
              );
            })}
          </div>

          {value && (
            <button
              type="button"
              onClick={() => {
                onChange(undefined);
                setOpen(false);
              }}
              className="mt-2.5 w-full rounded-lg border border-line px-3 py-1.5 text-xs text-mist-400 transition-colors hover:border-line-strong hover:bg-raise-2 hover:text-mist-200"
            >
              Clear due date
            </button>
          )}
        </div>
      )}
    </div>
  );
}
