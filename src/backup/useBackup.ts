import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../db";
import {
  getLastSyncAt,
  getRepo,
  getToken,
  isAuto,
  isConfigured,
  isRemembered,
  setAuto as persistAuto,
  setLastSyncAt,
  setRepo as persistRepo,
  setToken as persistToken,
  clearToken as forgetToken,
} from "./config";
import {
  BackupAuthError,
  BackupError,
  BackupNotConfiguredError,
  githubStore,
  type RepoConfig,
} from "./github";
import { runBackup, type BackupResult } from "./sync";

/**
 * How long to wait after an edit before saving.
 *
 * Every save is a commit, so reacting to each keystroke would bury the real
 * history under hundreds of one-character diffs. A few seconds of quiet is long
 * enough to batch a burst of edits and short enough that closing the tab
 * straight after typing still catches them.
 */
const QUIET_MS = 4000;

/**
 * The shortest gap between two runs the app starts by itself.
 *
 * Returning to the tab is a good moment to check for changes from another
 * device, but it happens often enough — every alt-tab — to be worth rate
 * limiting. Pressing the button ignores this.
 */
const REFRESH_MS = 60_000;

export interface UseBackup {
  repo: RepoConfig;
  configured: boolean;
  hasToken: boolean;
  remember: boolean;
  auto: boolean;
  running: boolean;
  lastSyncAt?: number;
  lastResult: BackupResult | null;
  error: string | null;
  saveRepo: (repo: RepoConfig) => void;
  saveToken: (token: string, remember: boolean) => void;
  clearToken: () => void;
  setAuto: (on: boolean) => void;
  syncNow: () => Promise<void>;
}

function message(err: unknown): string {
  if (err instanceof BackupAuthError) return err.message;
  if (err instanceof BackupError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Keeps the board in step with the JSON file in a GitHub repository.
 *
 * Lives at the app root rather than in the sync tab so that saving carries on
 * while the user is anywhere else in the app — the tab they are least likely to
 * be looking at when they make a change is the one about syncing.
 */
export function useBackup(): UseBackup {
  const [repo, setRepoState] = useState<RepoConfig>(() => getRepo());
  const [hasToken, setHasToken] = useState(() => Boolean(getToken()));
  const [remember, setRemember] = useState(() => isRemembered());
  const [auto, setAutoState] = useState(() => isAuto());
  const [running, setRunning] = useState(false);
  const [lastSyncAt, setLastAt] = useState<number | undefined>(() =>
    getLastSyncAt(),
  );
  const [lastResult, setLastResult] = useState<BackupResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A run reads the whole file and writes it back, so two at once would race
  // each other rather than the other device. Overlapping requests are collapsed
  // into a single follow-up instead of being queued.
  const runningRef = useRef(false);
  const pendingRef = useRef(false);

  const configured = isConfigured(repo);

  const sync = useCallback(async (): Promise<void> => {
    if (runningRef.current) {
      pendingRef.current = true;
      return;
    }
    const config = getRepo();
    const token = getToken();
    if (!isConfigured(config) || !token) {
      setError(
        !isConfigured(config)
          ? "Add the repository that should hold the file."
          : "Add a token so the app can reach the repository.",
      );
      return;
    }

    runningRef.current = true;
    setRunning(true);
    setError(null);
    try {
      const result = await runBackup(githubStore(config, token));
      setLastResult(result);
      setLastAt(result.at);
      setLastSyncAt(result.at);
    } catch (err) {
      if (!(err instanceof BackupNotConfiguredError)) setError(message(err));
    } finally {
      runningRef.current = false;
      setRunning(false);
      if (pendingRef.current) {
        pendingRef.current = false;
        void sync();
      }
    }
  }, []);

  // A cheap stand-in for "the board changed". Counts catch additions and
  // removals, the newest stamp catches edits, and the graveyard catches a
  // deletion that happens to leave the counts looking the same.
  const revision = useLiveQuery(async () => {
    const [tasks, projects, graves] = await Promise.all([
      db.tasks.toArray(),
      db.projects.toArray(),
      db.graveyard.count(),
    ]);
    const newest = [...tasks, ...projects].reduce(
      (max, r) => Math.max(max, r.updatedAt ?? 0),
      0,
    );
    return `${tasks.length}:${projects.length}:${graves}:${newest}`;
  }, []);

  const ready = auto && configured && hasToken;

  useEffect(() => {
    if (!ready || revision === undefined) return;
    const timer = setTimeout(() => void sync(), QUIET_MS);
    return () => clearTimeout(timer);
  }, [ready, revision, sync]);

  // Coming back to the tab is when another device's changes are most likely to
  // be waiting, and when a stale board is most likely to be edited on top of.
  useEffect(() => {
    if (!ready) return;
    const onFocus = () => {
      if (document.visibilityState === "hidden") return;
      const since = Date.now() - (getLastSyncAt() ?? 0);
      if (since < REFRESH_MS) return;
      void sync();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [ready, sync]);

  const saveRepo = useCallback((next: RepoConfig) => {
    persistRepo(next);
    setRepoState(getRepo());
    setError(null);
  }, []);

  const saveToken = useCallback((token: string, keep: boolean) => {
    persistToken(token, keep);
    setHasToken(Boolean(getToken()));
    setRemember(keep);
    setError(null);
  }, []);

  const clearToken = useCallback(() => {
    forgetToken();
    setHasToken(false);
  }, []);

  const setAuto = useCallback((on: boolean) => {
    persistAuto(on);
    setAutoState(on);
  }, []);

  return {
    repo,
    configured,
    hasToken,
    remember,
    auto,
    running,
    lastSyncAt,
    lastResult,
    error,
    saveRepo,
    saveToken,
    clearToken,
    setAuto,
    syncNow: sync,
  };
}
