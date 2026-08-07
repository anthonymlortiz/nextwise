import type { RepoConfig } from './github';

/**
 * Where the board file lives, and the token that opens it.
 *
 * The repository coordinates are ordinary settings. The token is not: it is a
 * bearer credential, and the app's standing rule is that those live in memory
 * only (see `chat/key.ts`). That rule is relaxed here for one honest reason —
 * the point of this feature is that the board saves itself, and a token the
 * user must re-paste after every reload cannot do that. So persisting is the
 * default, and the panel says plainly what it means.
 */
const REPO_KEY = 'pp.backup.repo';
const TOKEN_KEY = 'pp.backup.token';
const REMEMBER_KEY = 'pp.backup.remember';
const AUTO_KEY = 'pp.backup.auto';
const LAST_KEY = 'pp.backup.lastSyncAt';

export const DEFAULT_PATH = 'nextwise/board.json';

export const EMPTY_REPO: RepoConfig = { owner: '', repo: '', branch: 'main', path: DEFAULT_PATH };

export function getRepo(): RepoConfig {
  try {
    const raw = localStorage.getItem(REPO_KEY);
    if (!raw) return { ...EMPTY_REPO };
    const parsed = JSON.parse(raw) as Partial<RepoConfig>;
    return {
      owner: parsed.owner?.trim() ?? '',
      repo: parsed.repo?.trim() ?? '',
      branch: parsed.branch?.trim() || 'main',
      path: parsed.path?.trim() || DEFAULT_PATH,
    };
  } catch {
    return { ...EMPTY_REPO };
  }
}

export function setRepo(config: RepoConfig): void {
  localStorage.setItem(REPO_KEY, JSON.stringify(config));
}

export function isConfigured(config: RepoConfig = getRepo()): boolean {
  return Boolean(config.owner && config.repo && config.path);
}

/**
 * Accepts the three shapes people actually have to hand: `owner/repo`, a full
 * `https://github.com/owner/repo` URL, or the two fields typed separately.
 * Getting this wrong is otherwise a 404 with nothing to explain it.
 */
export function parseRepoInput(input: string): { owner: string; repo: string } | null {
  const trimmed = input.trim().replace(/\.git$/, '');
  if (!trimmed) return null;
  const url = trimmed.match(/github\.com[/:]([^/]+)\/([^/]+)/);
  const pair = url ? [url[1], url[2]] : trimmed.split('/');
  if (pair.length !== 2) return null;
  const [owner, repo] = pair.map((s) => s.trim());
  if (!owner || !repo) return null;
  return { owner, repo };
}

let memoryToken = '';

export function isRemembered(): boolean {
  // Unlike the Claude key this defaults to on, because unattended saving is the
  // entire feature and it cannot run without a token after a reload.
  return localStorage.getItem(REMEMBER_KEY) !== '0';
}

export function getToken(): string {
  if (memoryToken) return memoryToken;
  if (isRemembered()) memoryToken = localStorage.getItem(TOKEN_KEY) ?? '';
  return memoryToken;
}

export function setToken(token: string, remember: boolean): void {
  memoryToken = token.trim();
  localStorage.setItem(REMEMBER_KEY, remember ? '1' : '0');
  if (remember && memoryToken) localStorage.setItem(TOKEN_KEY, memoryToken);
  else localStorage.removeItem(TOKEN_KEY);
}

export function clearToken(): void {
  memoryToken = '';
  localStorage.removeItem(TOKEN_KEY);
}

/**
 * GitHub's own prefixes. Checking them turns the most common paste mistake into
 * an immediate message rather than a 401 after a round trip, but stays a
 * warning in case the prefixes change.
 */
export function looksLikeToken(token: string): boolean {
  return /^(github_pat_|ghp_|gho_|ghs_)/.test(token.trim());
}

export function isAuto(): boolean {
  return localStorage.getItem(AUTO_KEY) !== '0';
}

export function setAuto(on: boolean): void {
  localStorage.setItem(AUTO_KEY, on ? '1' : '0');
}

export function getLastSyncAt(): number | undefined {
  const raw = Number(localStorage.getItem(LAST_KEY));
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

export function setLastSyncAt(at: number): void {
  localStorage.setItem(LAST_KEY, String(at));
}
