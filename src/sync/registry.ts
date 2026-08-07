import type { ProviderId } from '../types';
import * as ms from './auth';
import * as google from './googleAuth';
import { MsGraphClient } from './graphClient';
import { GoogleTasksClient } from './googleClient';
import { msProvider } from './msProvider';
import { googleProvider } from './googleProvider';
import type { SyncProvider } from './provider';

/**
 * One entry per service, pairing its auth module with the adapter that builds a
 * `SyncProvider`. The UI and the sync hook iterate this list, so adding another
 * service is a matter of adding a row here rather than touching either of them.
 */
export interface ProviderRegistration {
  id: ProviderId;
  label: string;
  /** Shown next to the client-id field so the user knows what to paste. */
  clientIdLabel: string;
  /** Where that value comes from, and what the redirect/origin must be. */
  setupUrl: string;
  getClientId(): string;
  setClientId(id: string): void;
  /** Identifies the connected account, or null when not connected. */
  accountLabel(): Promise<string | null>;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  create(): SyncProvider;
}

export const REGISTRY: ProviderRegistration[] = [
  {
    id: 'mstodo',
    label: 'Microsoft To Do',
    clientIdLabel: 'Application (client) ID',
    setupUrl: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    getClientId: ms.getClientId,
    setClientId: ms.setClientId,
    async accountLabel() {
      return (await ms.getAccount())?.username ?? null;
    },
    async signIn() {
      await ms.signIn();
    },
    signOut: ms.signOut,
    create: () => msProvider(new MsGraphClient(ms.getAccessToken)),
  },
  {
    id: 'gtasks',
    label: 'Google Tasks',
    clientIdLabel: 'OAuth client ID',
    setupUrl: 'https://console.cloud.google.com/apis/credentials',
    getClientId: google.getClientId,
    setClientId: google.setClientId,
    // Google's token flow never reveals the address without a wider scope, so
    // the connection itself is all we can honestly report.
    async accountLabel() {
      return google.isConnected() ? 'Connected' : null;
    },
    async signIn() {
      await google.signIn();
    },
    signOut: google.signOut,
    create: () => googleProvider(new GoogleTasksClient(google.getAccessToken)),
  },
];

export function registrationFor(id: ProviderId): ProviderRegistration {
  const found = REGISTRY.find((r) => r.id === id);
  if (!found) throw new Error(`Unknown provider ${id}`);
  return found;
}
