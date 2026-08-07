/**
 * Development-only console hooks.
 *
 * Loaded through a dynamic import behind `import.meta.env.DEV` so none of this —
 * including the in-memory service fakes — is bundled into a production build.
 */
export async function installDevHooks(): Promise<void> {
  const [
    engine,
    fakeGraph,
    fakeGoogle,
    dbModule,
    mapping,
    googleMapping,
    ms,
    google,
    links,
    footer,
    auth,
    fakeClaude,
    chatKey,
    chatTools,
  ] = await Promise.all([    import('./sync/engine'),
    import('./sync/fakeGraph'),
    import('./sync/fakeGoogle'),
    import('./db'),
    import('./sync/mapping'),
    import('./sync/googleMapping'),
    import('./sync/msProvider'),
    import('./sync/googleProvider'),
    import('./sync/links'),
    import('./sync/footer'),
    import('./sync/auth'),
    import('./chat/fakeClaude'),
    import('./chat/key'),
    import('./chat/tools'),
  ]);

  (globalThis as Record<string, unknown>).__fb = {
    db: dbModule.db,
    runSync: engine.runSync,
    recordTombstone: engine.recordTombstone,
    resetSyncState: engine.resetSyncState,
    getLastSyncAt: engine.getLastSyncAt,
    FakeGraphClient: fakeGraph.FakeGraphClient,
    FakeGoogleClient: fakeGoogle.FakeGoogleClient,
    msProvider: ms.msProvider,
    googleProvider: google.googleProvider,
    links,
    footer,
    mapping,
    googleMapping,
    auth,
    FakeClaudeTransport: fakeClaude.FakeClaudeTransport,
    chatKey,
    chatTools,
    session: await import('./session'),
    backup: {
      ...(await import('./backup/snapshot')),
      ...(await import('./backup/store')),
      ...(await import('./backup/sync')),
      ...(await import('./backup/config')),
      ...(await import('./backup/github')),
      FakeGitHubFile: (await import('./backup/fakeGitHub')).FakeGitHubFile,
    },
  };
}
