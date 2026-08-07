import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProviderId } from '../types';
import { getLastSyncAt, resetSyncState, runSync, type SyncResult } from './engine';
import { REGISTRY, type ProviderRegistration } from './registry';

const AUTO_KEY = 'pp.sync.auto';
const AUTO_INTERVAL_MS = 5 * 60 * 1000;

/** Everything the UI needs about one connected service. */
export interface ProviderSync {
  id: ProviderId;
  label: string;
  clientIdLabel: string;
  setupUrl: string;
  clientId: string;
  saveClientId: (id: string) => void;
  /** Account identifier when connected, otherwise null. */
  account: string | null;
  busy: boolean;
  syncing: boolean;
  lastSyncAt?: number;
  lastResult: SyncResult | null;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  syncNow: () => Promise<void>;
  forgetLinks: () => Promise<void>;
}

export interface UseSync {
  providers: ProviderSync[];
  /** True while any provider is running. */
  syncing: boolean;
  /** Most recent successful run across all providers. */
  lastSyncAt?: number;
  connectedCount: number;
  autoSync: boolean;
  setAutoSync: (on: boolean) => void;
  /** Runs every connected provider, one after another. */
  syncAll: () => Promise<void>;
}

interface ProviderState {
  account: string | null;
  clientId: string;
  busy: boolean;
  syncing: boolean;
  lastSyncAt?: number;
  lastResult: SyncResult | null;
  error: string | null;
}

const initialState = (reg: ProviderRegistration): ProviderState => ({
  account: null,
  clientId: reg.getClientId(),
  busy: false,
  syncing: false,
  lastResult: null,
  error: null,
});

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Owns sync state for every provider. Lives at the app root rather than inside
 * the sync tab so the timer keeps running (and the header keeps reporting) no
 * matter which tab is open.
 *
 * Each service is tracked independently — connecting, failing or resetting one
 * has no effect on the other, which matters because a board can legitimately be
 * mirrored to both at once.
 */
export function useSync(): UseSync {
  const [states, setStates] = useState<Record<string, ProviderState>>(() =>
    Object.fromEntries(REGISTRY.map((reg) => [reg.id, initialState(reg)])),
  );
  const [autoSync, setAutoSyncState] = useState(() => localStorage.getItem(AUTO_KEY) === '1');

  // Guards against overlapping runs: the interval, the auto-sync effect and the
  // buttons all funnel through here, and two concurrent runs would double-push.
  const running = useRef<Set<ProviderId>>(new Set());

  const patch = useCallback((id: ProviderId, changes: Partial<ProviderState>) => {
    setStates((prev) => ({ ...prev, [id]: { ...prev[id], ...changes } }));
  }, []);

  // Restore connection status and last-run time for each provider on mount.
  useEffect(() => {
    let cancelled = false;
    for (const reg of REGISTRY) {
      void Promise.all([reg.accountLabel().catch(() => null), getLastSyncAt(reg.id)]).then(
        ([account, lastSyncAt]) => {
          if (!cancelled) patch(reg.id, { account, lastSyncAt });
        },
      );
    }
    return () => {
      cancelled = true;
    };
  }, [patch]);

  const syncProvider = useCallback(
    async (reg: ProviderRegistration) => {
      if (running.current.has(reg.id)) return;
      running.current.add(reg.id);
      patch(reg.id, { syncing: true, error: null });
      try {
        const result = await runSync(reg.create());
        patch(reg.id, {
          lastResult: result,
          lastSyncAt: result.finishedAt,
          error: result.ok ? null : (result.errors[0] ?? 'Sync finished with errors.'),
        });
      } catch (err) {
        patch(reg.id, { error: message(err) });
      } finally {
        running.current.delete(reg.id);
        patch(reg.id, { syncing: false });
      }
    },
    [patch],
  );

  /**
   * Providers run sequentially rather than in parallel: both write the same
   * Dexie tables, and interleaving them would let one create a task the other
   * has not yet linked, producing duplicates.
   */
  const syncAll = useCallback(async () => {
    for (const reg of REGISTRY) {
      if (states[reg.id]?.account) await syncProvider(reg);
    }
  }, [states, syncProvider]);

  const connectedKey = REGISTRY.map((reg) => (states[reg.id]?.account ? '1' : '0')).join('');

  // The interval must always call the current closure: `syncAll` changes on
  // every state update, so capturing it directly would either freeze it at
  // mount (and never see a connected account) or restart the timer constantly.
  const syncAllRef = useRef(syncAll);
  useEffect(() => {
    syncAllRef.current = syncAll;
  }, [syncAll]);

  useEffect(() => {
    if (!autoSync || !connectedKey.includes('1')) return;
    void syncAllRef.current();
    const id = window.setInterval(() => void syncAllRef.current(), AUTO_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [autoSync, connectedKey]);

  const setAutoSync = useCallback((on: boolean) => {
    localStorage.setItem(AUTO_KEY, on ? '1' : '0');
    setAutoSyncState(on);
  }, []);

  const providers = useMemo<ProviderSync[]>(
    () =>
      REGISTRY.map((reg) => {
        const state = states[reg.id];
        return {
          id: reg.id,
          label: reg.label,
          clientIdLabel: reg.clientIdLabel,
          setupUrl: reg.setupUrl,
          clientId: state.clientId,
          account: state.account,
          busy: state.busy,
          syncing: state.syncing,
          lastSyncAt: state.lastSyncAt,
          lastResult: state.lastResult,
          error: state.error,

          saveClientId: (id: string) => {
            reg.setClientId(id);
            patch(reg.id, { clientId: reg.getClientId(), account: null, error: null });
          },

          connect: async () => {
            patch(reg.id, { busy: true, error: null });
            try {
              await reg.signIn();
              patch(reg.id, { account: await reg.accountLabel() });
            } catch (err) {
              patch(reg.id, { error: message(err) });
            } finally {
              patch(reg.id, { busy: false });
            }
          },

          disconnect: async () => {
            patch(reg.id, { busy: true });
            try {
              await reg.signOut();
              patch(reg.id, { account: null, lastResult: null });
            } catch (err) {
              patch(reg.id, { error: message(err) });
            } finally {
              patch(reg.id, { busy: false });
            }
          },

          syncNow: () => syncProvider(reg),

          // Drops this provider's cursors and links without touching task
          // content, so its next run re-matches everything from scratch. The
          // escape hatch for a corrupted link state, and it deliberately leaves
          // the other service's links alone.
          forgetLinks: async () => {
            await resetSyncState(reg.id);
            patch(reg.id, { lastSyncAt: undefined, lastResult: null, error: null });
          },
        };
      }),
    [states, patch, syncProvider],
  );

  const lastSyncTimes = providers.map((p) => p.lastSyncAt).filter((t): t is number => !!t);

  return {
    providers,
    syncing: providers.some((p) => p.syncing),
    lastSyncAt: lastSyncTimes.length ? Math.max(...lastSyncTimes) : undefined,
    connectedCount: providers.filter((p) => p.account).length,
    autoSync,
    setAutoSync,
    syncAll,
  };
}
