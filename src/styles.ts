import type { Domain, FocusLevel, Priority } from './types';

/**
 * Colour is reserved for urgency, not for category.
 *
 * The old palette gave every attribute its own bright pill, so a P1 due today
 * and a `#research` tag shouted equally loudly and the eye had nowhere to land.
 * Now priority drives a saturation ramp — P1 is the only genuinely loud thing on
 * a row and P4 is almost silent — while descriptive attributes (focus, area,
 * tags, duration) render in quiet monochrome.
 */
export const PRIORITY_STYLE: Record<Priority, string> = {
  1: 'bg-rose-500/15 text-danger border-rose-400/25',
  2: 'bg-amber-500/10 text-warn border-amber-400/20',
  3: 'bg-raise-1 text-mist-400 border-line',
  4: 'bg-raise-1 text-mist-500 border-line',
};

/** The vertical rail down the left edge of a task row. */
export const PRIORITY_RAIL: Record<Priority, string> = {
  1: 'bg-rail-1',
  2: 'bg-rail-2',
  3: 'bg-rail-3',
  4: 'bg-rail-4',
};

export const PRIORITY_TEXT: Record<Priority, string> = {
  1: 'text-danger',
  2: 'text-warn',
  3: 'text-mist-400',
  4: 'text-mist-500',
};

export const FOCUS_STYLE: Record<FocusLevel, string> = {
  deep: 'bg-violet-500/10 text-deep border-violet-400/20',
  medium: 'bg-raise-1 text-mist-400 border-line',
  shallow: 'bg-raise-1 text-mist-400 border-line',
};

/** A dot, not a pill — enough to spot deep work at a glance without shouting. */
export const FOCUS_DOT: Record<FocusLevel, string> = {
  deep: 'bg-deep',
  medium: 'bg-teal-500/70',
  shallow: 'bg-mist-500',
};

export const DOMAIN_STYLE: Record<Domain, string> = {
  work: 'bg-indigo-500/15 text-work border-indigo-400/25',
  personal: 'bg-fuchsia-500/15 text-personal border-fuchsia-400/25',
};

export const DOMAIN_DOT: Record<Domain, string> = {
  work: 'bg-work',
  personal: 'bg-personal',
};

export function formatMinutes(min: number): string {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
