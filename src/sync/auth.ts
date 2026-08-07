import type { AccountInfo, Configuration, PublicClientApplication } from '@azure/msal-browser';

/**
 * MSAL is ~180 kB and only matters once someone actually connects an account,
 * so it is pulled in on demand instead of riding along in the initial bundle.
 */
type MsalModule = typeof import('@azure/msal-browser');
let msalModule: Promise<MsalModule> | null = null;
const loadMsal = (): Promise<MsalModule> => (msalModule ??= import('@azure/msal-browser'));

/**
 * Only the delegated permission we actually need. Requesting the narrowest
 * scope keeps the consent prompt honest and limits blast radius.
 */
export const GRAPH_SCOPES = ['Tasks.ReadWrite'];

const CLIENT_ID_KEY = 'pp.msal.clientId';

/**
 * The address the app is actually served from — what Entra needs registered as
 * the redirect URI.
 *
 * For a normal root deployment `BASE_URL` is `/` and this returns the bare
 * origin, byte-identical to what earlier builds used. That matters: Entra
 * matches redirect URIs exactly, and `https://host` and `https://host/` are two
 * different registrations, so computing the "tidier" trailing-slash form would
 * silently break every existing setup.
 *
 * For a subfolder build it returns `https://host/folder/`, and the trailing
 * slash is kept on purpose — static hosts answer the slashless form with a 301,
 * and following a redirect would drop the fragment MSAL hands back.
 */
export function appUrl(): string {
  const base = import.meta.env.BASE_URL;
  if (!base || base === '/') return window.location.origin;
  return new URL(base, window.location.origin).href;
}

/**
 * The client id is supplied by the user at runtime rather than compiled in.
 * A SPA client id is not a secret, but hardcoding one would tie every install
 * to a single app registration and bake a deployment detail into source.
 */
export function getClientId(): string {
  return localStorage.getItem(CLIENT_ID_KEY) ?? '';
}

export function setClientId(id: string): void {
  const trimmed = id.trim();
  if (trimmed) localStorage.setItem(CLIENT_ID_KEY, trimmed);
  else localStorage.removeItem(CLIENT_ID_KEY);
  instance = null;
  initialised = null;
}

function buildConfig(clientId: string): Configuration {
  return {
    auth: {
      clientId,
      // "common" lets both personal Microsoft accounts and work/school accounts in.
      authority: 'https://login.microsoftonline.com/common',
      redirectUri: appUrl(),
    },
    cache: {
      // Survives a reload so the user is not pushed through consent every visit.
      cacheLocation: 'localStorage',
    },
  };
}

let instance: PublicClientApplication | null = null;
let initialised: Promise<void> | null = null;

export class AuthNotConfiguredError extends Error {
  constructor() {
    super('Add your Azure application (client) ID before connecting.');
    this.name = 'AuthNotConfiguredError';
  }
}

async function getInstance(): Promise<PublicClientApplication> {
  const clientId = getClientId();
  if (!clientId) throw new AuthNotConfiguredError();

  if (!instance) {
    const msal = await loadMsal();
    instance = new msal.PublicClientApplication(buildConfig(clientId));
    initialised = instance.initialize();
  }
  await initialised;
  return instance;
}

export async function getAccount(): Promise<AccountInfo | null> {
  if (!getClientId()) return null;
  const msal = await getInstance();
  return msal.getAllAccounts()[0] ?? null;
}

export async function signIn(): Promise<AccountInfo> {
  const msal = await getInstance();
  const result = await msal.loginPopup({ scopes: GRAPH_SCOPES, prompt: 'select_account' });
  msal.setActiveAccount(result.account);
  return result.account;
}

export async function signOut(): Promise<void> {
  const msal = await getInstance();
  const account = msal.getAllAccounts()[0];
  if (account) await msal.clearCache({ account });
}

/**
 * Token provider for the Graph client. Silent acquisition covers the common
 * case; the popup fallback handles expired refresh tokens and new consent
 * requirements, which silent calls surface as InteractionRequiredAuthError.
 */
export async function getAccessToken(): Promise<string> {
  const msal = await getInstance();
  const account = msal.getActiveAccount() ?? msal.getAllAccounts()[0];
  if (!account) throw new Error('Not signed in to Microsoft.');

  try {
    const result = await msal.acquireTokenSilent({ scopes: GRAPH_SCOPES, account });
    return result.accessToken;
  } catch (err) {
    const { InteractionRequiredAuthError } = await loadMsal();
    if (err instanceof InteractionRequiredAuthError) {
      const result = await msal.acquireTokenPopup({ scopes: GRAPH_SCOPES, account });
      return result.accessToken;
    }
    throw err;
  }
}
