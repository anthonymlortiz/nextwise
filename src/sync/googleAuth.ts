/**
 * Google auth via Google Identity Services.
 *
 * GIS only issues short-lived access tokens to browser apps — there is no
 * refresh token, by design, because a public client cannot keep one secret.
 * So a token is held in memory for its hour and then renewed silently through
 * the hidden GIS iframe, which works as long as the user still has a Google
 * session and has already consented.
 *
 * Only the flag saying "this user connected Google" is persisted; tokens are
 * deliberately never written to storage.
 */

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface TokenClient {
  requestAccessToken(overrides?: { prompt?: string }): void;
}

interface GoogleIdentity {
  accounts: {
    oauth2: {
      initTokenClient(config: {
        client_id: string;
        scope: string;
        prompt?: string;
        callback: (response: TokenResponse) => void;
        error_callback?: (error: { type?: string; message?: string }) => void;
      }): TokenClient;
      revoke(token: string, done: () => void): void;
    };
  };
}

declare global {
  interface Window {
    google?: GoogleIdentity;
  }
}

/** Read/write access to Tasks, and nothing else. */
export const TASKS_SCOPE = 'https://www.googleapis.com/auth/tasks';

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const CLIENT_ID_KEY = 'pp.gis.clientId';
const CONNECTED_KEY = 'pp.gis.connected';

/** Renew a little early so a sync never starts with an almost-dead token. */
const EXPIRY_SKEW_MS = 60_000;

export class GoogleAuthNotConfiguredError extends Error {
  constructor() {
    super('Add your Google OAuth client ID before connecting.');
    this.name = 'GoogleAuthNotConfiguredError';
  }
}

export class GoogleReauthRequiredError extends Error {
  constructor(message = 'Google sign-in expired. Connect again to resume syncing.') {
    super(message);
    this.name = 'GoogleReauthRequiredError';
  }
}

/**
 * Supplied by the user at runtime rather than compiled in. A browser OAuth
 * client id is not a secret, but hardcoding one would tie every install to a
 * single Cloud project.
 */
export function getClientId(): string {
  return localStorage.getItem(CLIENT_ID_KEY) ?? '';
}

export function setClientId(id: string): void {
  const trimmed = id.trim();
  if (trimmed) localStorage.setItem(CLIENT_ID_KEY, trimmed);
  else localStorage.removeItem(CLIENT_ID_KEY);
  tokenClient = null;
  accessToken = null;
  expiresAt = 0;
}

export function isConnected(): boolean {
  return localStorage.getItem(CONNECTED_KEY) === '1';
}

/**
 * The GIS script is ~40 kB and only matters once someone connects Google, so it
 * is injected on demand rather than sitting in index.html.
 */
let scriptPromise: Promise<void> | null = null;

function loadGis(): Promise<void> {
  scriptPromise ??= new Promise<void>((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve();

    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SRC}"]`);
    const script = existing ?? document.createElement('script');
    script.addEventListener('load', () => resolve());
    script.addEventListener('error', () => {
      scriptPromise = null;
      reject(new Error('Could not load Google Identity Services.'));
    });
    if (!existing) {
      script.src = GIS_SRC;
      script.async = true;
      document.head.appendChild(script);
    }
  });
  return scriptPromise;
}

let tokenClient: TokenClient | null = null;
let accessToken: string | null = null;
let expiresAt = 0;
let pending: Promise<string> | null = null;
let settle: ((r: TokenResponse | Error) => void) | null = null;

async function getTokenClient(): Promise<TokenClient> {
  const clientId = getClientId();
  if (!clientId) throw new GoogleAuthNotConfiguredError();

  if (!tokenClient) {
    await loadGis();
    const oauth2 = window.google?.accounts?.oauth2;
    if (!oauth2) throw new Error('Google Identity Services failed to initialise.');

    tokenClient = oauth2.initTokenClient({
      client_id: clientId,
      scope: TASKS_SCOPE,
      // One shared callback: only one request is ever in flight at a time.
      callback: (response) => settle?.(response),
      error_callback: (error) =>
        settle?.(new Error(error.message ?? error.type ?? 'Google sign-in failed.')),
    });
  }
  return tokenClient;
}

/**
 * `prompt: 'consent'` forces the account chooser for a deliberate connect;
 * `prompt: ''` is the silent path used for renewals.
 */
async function requestToken(prompt: string): Promise<string> {
  const client = await getTokenClient();

  pending ??= new Promise<string>((resolve, reject) => {
    settle = (result) => {
      settle = null;
      pending = null;
      if (result instanceof Error) return reject(result);
      if (result.error || !result.access_token) {
        return reject(
          prompt === ''
            ? new GoogleReauthRequiredError()
            : new Error(result.error_description ?? result.error ?? 'Google sign-in failed.'),
        );
      }
      accessToken = result.access_token;
      expiresAt = Date.now() + (result.expires_in ?? 3600) * 1000;
      localStorage.setItem(CONNECTED_KEY, '1');
      resolve(result.access_token);
    };
    client.requestAccessToken({ prompt });
  });

  return pending;
}

export function signIn(): Promise<string> {
  return requestToken('consent');
}

export async function signOut(): Promise<void> {
  const token = accessToken;
  accessToken = null;
  expiresAt = 0;
  localStorage.removeItem(CONNECTED_KEY);

  if (!token) return;
  await loadGis().catch(() => undefined);
  await new Promise<void>((resolve) => {
    const oauth2 = window.google?.accounts?.oauth2;
    if (!oauth2) return resolve();
    oauth2.revoke(token, resolve);
  });
}

/** Token provider for the Tasks client. */
export async function getAccessToken(): Promise<string> {
  if (accessToken && Date.now() < expiresAt - EXPIRY_SKEW_MS) return accessToken;
  if (!isConnected()) throw new GoogleReauthRequiredError('Not connected to Google.');
  return requestToken('');
}
