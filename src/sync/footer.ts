import type { Domain, FocusLevel, Priority, TaskContext } from '../types';
import { CONTEXTS } from '../types';
import { isValidISODate } from '../dates';

/**
 * Neither Microsoft To Do nor Google Tasks has a field for estimated duration
 * or focus level, and Google additionally has nothing for priority or tags. So
 * whatever a provider cannot store natively rides along in a single compact
 * line appended to the task's notes.
 *
 * It stays readable in the provider's own apps, survives edits to the prose
 * above it, and is rewritten in place rather than duplicated.
 *
 * Example: `[fb] est=45m focus=deep prio=P2 area=work ctx=laptop tags=writing`
 *
 * One field is deliberately *not* here: `blockedBy`. It holds a local row id,
 * which means nothing to another device that pulls the same task, so a
 * dependency stays inside this browser. The human-readable "waiting on" note
 * does travel, because that is the part another app can usefully show.
 */
const FOOTER_RE = /^[ \t]*\[fb\][ \t]+(.*)$/im;

export interface FooterMeta {
  estimateMin?: number;
  focusLevel?: FocusLevel;
  priority?: Priority;
  domain?: Domain;
  context?: TaskContext;
  startDate?: string;
  blockedNote?: string;
  tags?: string[];
}

/**
 * Values are percent-encoded because the footer is parsed on whitespace, so a
 * tag like "next week" would otherwise truncate the rest of the line. Ordinary
 * tags contain no reserved characters and so stay human-readable.
 */
const encodeTag = (tag: string) => encodeURIComponent(tag).replace(/,/g, '%2C');

const decodeValue = (raw: string) => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

export function buildFooter(meta: FooterMeta): string {
  const parts = [
    `est=${meta.estimateMin}m`,
    `focus=${meta.focusLevel}`,
    `prio=P${meta.priority}`,
    `area=${meta.domain}`,
  ];
  // The availability fields are optional in the model, so an unconstrained task
  // produces exactly the footer it always did and nothing re-syncs needlessly.
  if (meta.context) parts.push(`ctx=${meta.context}`);
  if (meta.startDate) parts.push(`start=${meta.startDate}`);
  if (meta.blockedNote) parts.push(`wait=${encodeTag(meta.blockedNote)}`);
  // Only emitted by providers with no native tag field, so To Do notes stay clean.
  if (meta.tags && meta.tags.length > 0) {
    parts.push(`tags=${meta.tags.map(encodeTag).join(',')}`);
  }
  return `[fb] ${parts.join(' ')}`;
}

const FOCUS_VALUES: FocusLevel[] = ['deep', 'medium', 'shallow'];

export function parseFooter(line: string): FooterMeta {
  const meta: FooterMeta = {};
  for (const [, key, raw] of line.matchAll(/(\w+)=([^\s]+)/g)) {
    switch (key) {
      case 'est': {
        const n = Number.parseInt(raw, 10);
        if (Number.isFinite(n) && n > 0) meta.estimateMin = n;
        break;
      }
      case 'focus':
        if ((FOCUS_VALUES as string[]).includes(raw)) meta.focusLevel = raw as FocusLevel;
        break;
      case 'prio': {
        const n = Number.parseInt(raw.replace(/^P/i, ''), 10);
        if (n >= 1 && n <= 4) meta.priority = n as Priority;
        break;
      }
      case 'area':
        if (raw === 'work' || raw === 'personal') meta.domain = raw;
        break;
      case 'ctx':
        if ((CONTEXTS as string[]).includes(raw)) meta.context = raw as TaskContext;
        break;
      case 'start':
        if (isValidISODate(raw)) meta.startDate = raw;
        break;
      case 'wait': {
        const note = decodeValue(raw).trim();
        if (note) meta.blockedNote = note;
        break;
      }
      case 'tags':
        meta.tags = raw
          .split(',')
          .map(decodeValue)
          .filter(Boolean);
        break;
    }
  }
  return meta;
}

/** Splits a remote body into the user's prose and our machine metadata. */
export function splitBody(body: string | undefined): { notes: string; meta: FooterMeta } {
  if (!body) return { notes: '', meta: {} };
  const match = body.match(FOOTER_RE);
  if (!match) return { notes: body.trim(), meta: {} };
  const notes = (body.slice(0, match.index) + body.slice(match.index! + match[0].length)).trim();
  return { notes, meta: parseFooter(match[1]) };
}

/**
 * Re-attaches the metadata footer, replacing any existing one so repeated syncs
 * never stack duplicates.
 */
export function joinBody(notes: string, meta: FooterMeta): string {
  const clean = notes.replace(FOOTER_RE, '').trim();
  const footer = buildFooter(meta);
  return clean ? `${clean}\n\n${footer}` : footer;
}
