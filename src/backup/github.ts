/**
 * Reading and writing one file in a GitHub repository, straight from the
 * browser.
 *
 * `api.github.com` sends `access-control-allow-origin: *`, so no server is
 * needed in the middle — which matters, because the app has none. The contents
 * API is used rather than the git plumbing because it does the whole
 * read-modify-write in two calls and enforces optimistic concurrency for us:
 * a write carries the blob sha it was based on, and GitHub rejects it if the
 * file has moved on since.
 */

export interface RepoConfig {
  owner: string;
  repo: string;
  branch: string;
  path: string;
}

export interface StoredFile {
  text: string;
  /** Blob sha of what was read, required to write it back safely. */
  sha: string;
}

/**
 * The one file the backup needs, abstracted so tests can run the whole merge
 * and conflict story against an in-memory stand-in.
 */
export interface FileStore {
  /** Null when the file does not exist yet, which is the first-run case. */
  read(): Promise<StoredFile | null>;
  write(text: string, sha: string | null, message: string): Promise<StoredFile>;
}

export class BackupError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = 'BackupError';
    this.status = status;
  }
}

/** The token is missing, wrong, or lacks contents write on the repository. */
export class BackupAuthError extends BackupError {
  constructor(message: string, status: number) {
    super(message, status);
    this.name = 'BackupAuthError';
  }
}

/** The file moved on between the read and the write; re-read and merge again. */
export class BackupConflictError extends BackupError {
  constructor(message: string) {
    super(message, 409);
    this.name = 'BackupConflictError';
  }
}

export class BackupNotConfiguredError extends BackupError {
  constructor(message: string) {
    super(message, 0);
    this.name = 'BackupNotConfiguredError';
  }
}

/**
 * `btoa` only accepts code points below 256, so the text is encoded to UTF-8
 * bytes first. Task titles and notes routinely contain characters it would
 * otherwise reject — the app's own copy uses typographic quotes and dashes,
 * before any accent or emoji the user types.
 */
export function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  // Chunked because `String.fromCharCode(...bytes)` overflows the call stack
  // once a board grows past a few thousand tasks.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function fromBase64(encoded: string): string {
  // GitHub wraps its base64 at 60 characters, which `atob` will not accept.
  const binary = atob(encoded.replace(/\s/g, ''));
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

const API = 'https://api.github.com';

function headers(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

async function fail(response: Response, what: string): Promise<never> {
  let detail = '';
  try {
    const body = (await response.json()) as { message?: string };
    detail = body.message ? `: ${body.message}` : '';
  } catch {
    detail = '';
  }
  if (response.status === 401) {
    throw new BackupAuthError(`GitHub rejected the token${detail}`, 401);
  }
  if (response.status === 403) {
    throw new BackupAuthError(
      `The token is not allowed to do that${detail}. It needs Contents: read and write on this repository.`,
      403,
    );
  }
  throw new BackupError(`Could not ${what}${detail}`, response.status);
}

export function githubStore(config: RepoConfig, token: string): FileStore {
  if (!config.owner || !config.repo || !config.path) {
    throw new BackupNotConfiguredError('Set the repository and file path first.');
  }
  if (!token) throw new BackupNotConfiguredError('Add a GitHub token first.');

  const base = `${API}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;
  const contents = `${base}/contents/${config.path.split('/').map(encodeURIComponent).join('/')}`;

  return {
    async read() {
      const url = `${contents}?ref=${encodeURIComponent(config.branch)}`;
      const response = await fetch(url, { headers: headers(token) });
      if (response.status === 404) return null;
      if (!response.ok) await fail(response, 'read the file');

      const body = (await response.json()) as {
        content?: string;
        encoding?: string;
        sha: string;
        size?: number;
      };
      // Past a megabyte the contents API stops inlining the blob and returns an
      // empty string, which would look exactly like an empty board.
      if (body.encoding !== 'base64' || !body.content) {
        const blob = await fetch(`${base}/git/blobs/${body.sha}`, { headers: headers(token) });
        if (!blob.ok) await fail(blob, 'read the file');
        const blobBody = (await blob.json()) as { content: string };
        return { text: fromBase64(blobBody.content), sha: body.sha };
      }
      return { text: fromBase64(body.content), sha: body.sha };
    },

    async write(text, sha, message) {
      const response = await fetch(contents, {
        method: 'PUT',
        headers: headers(token),
        body: JSON.stringify({
          message,
          content: toBase64(text),
          branch: config.branch,
          ...(sha ? { sha } : {}),
        }),
      });
      // 409 is GitHub's own conflict; 422 is what it returns when the sha is
      // absent for a file that exists, which means someone else created it
      // between this run's read and write.
      if (response.status === 409 || response.status === 422) {
        throw new BackupConflictError('The file changed while this was saving.');
      }
      if (!response.ok) await fail(response, 'save the file');
      const body = (await response.json()) as { content: { sha: string } };
      return { text, sha: body.content.sha };
    },
  };
}
