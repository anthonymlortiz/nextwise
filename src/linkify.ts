/**
 * Turning URLs typed into a task into real links.
 *
 * Notes and titles are plain text everywhere else in the app — they round-trip
 * through Microsoft To Do and Google Tasks as plain text, and the `[fb]` footer
 * codec parses them — so linkifying is strictly a *display* concern. Nothing
 * here is ever written back to the database or pushed to a provider.
 *
 * The parser is deliberately narrow. It recognises three shapes and nothing
 * else, which is what makes it safe: an `href` can only ever come out as
 * `http:`, `https:` or `mailto:`, so there is no path by which a note
 * containing `javascript:alert(1)` becomes a clickable script.
 */

export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'link'; text: string; href: string };

// Angle brackets and quotes terminate a match so that `<https://x.com>` and
// `"https://x.com"` yield the bare URL rather than swallowing the delimiter.
const PATTERN =
  /\b(?:https?:\/\/|www\.)[^\s<>"'`]+|\b[^\s<>"'`@]+@[^\s<>"'`@]+\.[a-z]{2,}\b/gi;

const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/**
 * Prose puts punctuation right up against a URL — "see https://x.com/a." — and
 * the trailing stop is not part of the address. Brackets are only dropped when
 * they are unbalanced, so `https://en.wikipedia.org/wiki/Ruby_(gem)` keeps its
 * closing paren while `(see https://x.com)` does not.
 */
function trimTrailingPunctuation(match: string): string {
  let end = match.length;
  while (end > 0) {
    const ch = match[end - 1];
    if ('.,;:!?'.includes(ch)) {
      end -= 1;
      continue;
    }
    const opener = CLOSERS[ch];
    if (opener) {
      const inner = match.slice(0, end);
      const opens = inner.split(opener).length - 1;
      const closes = inner.split(ch).length - 1;
      if (closes > opens) {
        end -= 1;
        continue;
      }
    }
    break;
  }
  return match.slice(0, end);
}

/** The only three shapes that produce a link. Anything else returns null. */
export function hrefFor(text: string): string | null {
  if (/^https?:\/\/\S+$/i.test(text)) return text;
  if (/^www\.\S+$/i.test(text)) return `https://${text}`;
  if (/^[^\s<>"'`@]+@[^\s<>"'`@]+\.[a-z]{2,}$/i.test(text)) return `mailto:${text}`;
  return null;
}

/**
 * Splits text into alternating plain and link segments. Concatenating every
 * segment's `text` always reproduces the input exactly, so nothing is lost or
 * silently rewritten on screen.
 */
export function linkify(input: string): Segment[] {
  if (!input) return [];
  const out: Segment[] = [];
  let cursor = 0;

  PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PATTERN.exec(input)) !== null) {
    const raw = m[0];
    const candidate = trimTrailingPunctuation(raw);
    const href = candidate ? hrefFor(candidate) : null;

    // Rewind past the punctuation we declined to absorb so a following link is
    // still found, and so `lastIndex` can never move backwards into a loop.
    PATTERN.lastIndex = m.index + Math.max(candidate.length, 1);
    if (!href) continue;

    if (m.index > cursor) out.push({ kind: 'text', text: input.slice(cursor, m.index) });
    out.push({ kind: 'link', text: candidate, href });
    cursor = m.index + candidate.length;
  }

  if (cursor < input.length) out.push({ kind: 'text', text: input.slice(cursor) });
  return out;
}
