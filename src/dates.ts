/**
 * Date helpers for due dates, which are stored as plain `yyyy-MM-dd` strings.
 *
 * The one rule that matters here: **never use `toISOString()` to format a due
 * date.** It converts to UTC first, so for anyone west of Greenwich a date
 * picked in the afternoon comes back as the day before. Everything below works
 * in local time, matching `daysUntil()` in the recommender.
 */

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const pad = (n: number) => String(n).padStart(2, '0');

/** Local-time `yyyy-MM-dd`. */
export function toISODate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Parses `yyyy-MM-dd` as a local midnight, not a UTC one. */
export function fromISODate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function isValidISODate(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const parsed = fromISODate(iso);
  return !Number.isNaN(parsed.getTime()) && toISODate(parsed) === iso;
}

export function todayISO(now: Date = new Date()): string {
  return toISODate(now);
}

/**
 * Adding days via `setDate` rather than millisecond arithmetic, because a span
 * crossing a daylight-saving boundary is 23 or 25 hours, not 24.
 */
export function addDays(iso: string, days: number): string {
  const date = fromISODate(iso);
  date.setDate(date.getDate() + days);
  return toISODate(date);
}

export function addMonths(iso: string, months: number): string {
  const date = fromISODate(iso);
  const targetDay = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() + months);
  // Clamp so 31 January + 1 month lands on 28/29 February, not 3 March.
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(targetDay, lastDay));
  return toISODate(date);
}

/** The next occurrence of a weekday, always in the future. */
export function nextWeekday(weekday: number, now: Date = new Date()): string {
  const today = toISODate(now);
  const delta = (weekday - fromISODate(today).getDay() + 7) % 7;
  return addDays(today, delta === 0 ? 7 : delta);
}

/**
 * Six rows of seven, so the popover never changes height as you page through
 * months and the surrounding layout stays still.
 */
export function monthGrid(year: number, month: number): string[][] {
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - first.getDay());
  const weeks: string[][] = [];
  for (let w = 0; w < 6; w++) {
    const week: string[] = [];
    for (let d = 0; d < 7; d++) {
      week.push(toISODate(new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + d)));
    }
    weeks.push(week);
  }
  return weeks;
}

/** Plain-English distance from today, used to sanity-check a picked date. */
export function relativeLabel(iso: string, now: Date = new Date()): string {
  const days = Math.round(
    (fromISODate(iso).getTime() - fromISODate(toISODate(now)).getTime()) / 86400000,
  );
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  if (days < 0) return `${-days} days overdue`;
  if (days < 7) return `in ${days} days`;
  if (days < 14) return 'next week';
  return `in ${Math.round(days / 7)} weeks`;
}

/** e.g. "Fri 3 Oct". Year is added only when it isn't the current one. */
export function formatDate(iso: string, now: Date = new Date()): string {
  const date = fromISODate(iso);
  const base = `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()].slice(0, 3)}`;
  return date.getFullYear() === now.getFullYear() ? base : `${base} ${date.getFullYear()}`;
}
