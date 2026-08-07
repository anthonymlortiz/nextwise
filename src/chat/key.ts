/**
 * Storage for the user's own Anthropic API key.
 *
 * The app's rule for OAuth tokens is "memory only, never persisted", and an API
 * key deserves at least that much care: it is a bearer credential with billing
 * attached, and unlike an OAuth token it never expires on its own.
 *
 * So the default is memory-only, which means re-pasting after a reload. That is
 * genuinely annoying for something you use constantly, so persisting is offered
 * as an explicit opt-in rather than silently chosen for the user. Only the
 * choice is remembered by default; the key itself is written out only after the
 * user asks for it.
 */
const KEY_STORE = 'pp.claude.apiKey';
const REMEMBER_STORE = 'pp.claude.remember';

let memoryKey = '';

export function isRemembered(): boolean {
  return localStorage.getItem(REMEMBER_STORE) === '1';
}

export function getApiKey(): string {
  if (memoryKey) return memoryKey;
  if (isRemembered()) memoryKey = localStorage.getItem(KEY_STORE) ?? '';
  return memoryKey;
}

export function setApiKey(key: string, remember: boolean): void {
  memoryKey = key.trim();
  localStorage.setItem(REMEMBER_STORE, remember ? '1' : '0');
  if (remember && memoryKey) localStorage.setItem(KEY_STORE, memoryKey);
  else localStorage.removeItem(KEY_STORE);
}

export function clearApiKey(): void {
  memoryKey = '';
  localStorage.removeItem(KEY_STORE);
  localStorage.removeItem(REMEMBER_STORE);
}

/**
 * Anthropic keys start with a recognisable prefix. Checking it turns the most
 * common paste mistake into an immediate message instead of a 401 after a
 * round trip, but it stays a warning rather than a hard block in case the
 * prefix ever changes.
 */
export function looksLikeApiKey(key: string): boolean {
  return /^sk-ant-/.test(key.trim());
}
