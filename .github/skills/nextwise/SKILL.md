---
name: nextwise
description: Constraints, architecture and gotchas for the Nextwise personal productivity app (browser-only React/Dexie task recommender with two-way Microsoft To Do and Google Tasks sync). Use when working anywhere in the personal_productivity project — adding features, touching the sync engine, changing the recommender or database schema, or running its tests.
license: MIT
---

# Nextwise

**Naming:** the product is **Nextwise**. The assistant that does the recommending — the
first tab, the `FocusPanel` component and the `recommender` module — is called **jAIme**
in user-facing copy. Code identifiers stay `focus`/`recommend`; only the strings say jAIme.
The Dexie database is still `ProductivityDB` and `localStorage` keys still use the `pp.`
prefix: **never rename either**, that silently orphans the user's live data.

A browser-only productivity app that ranks tasks against the user's current situation
(time available, focus level, work vs personal, and where they physically are) and says
which one to do now. It syncs two-way with Microsoft To Do and Google Tasks.

**Two things are called "context" and they are not the same.** `Situation` (in
`types.ts`, persisted under `pp.context.v1`) is the user's current state — time, focus,
domain, project, and where they are. `TaskContext` is a property of a *task*: where it can
be done (`laptop | phone | home | office | errand`). The `Situation` type was originally
named `Context`; it was renamed when it gained its own `context` field. The storage key
and the `DEFAULT_CONTEXT` / `loadContext` identifiers were **not** renamed — see
constraint 4.

Read `README.md` for product behaviour. This file covers the things that are easy to get
wrong and expensive to rediscover.

## Non-negotiable constraints

1. **No backend, ever.** No server, no accounts, no hosted database. Everything lives in
   IndexedDB in the user's browser. If a feature seems to need a server, it needs a
   different design. All outbound traffic goes directly from the browser to something the
   user owns: their Microsoft/Google account, or their own GitHub repository. The GitHub
   backup is not an exception to this — the repository is storage, not a service, and the
   app is still the only thing that understands the file.
2. **No secrets in the app.** Both auth flows are public-client (PKCE / GIS token flow).
   There is no client secret anywhere, and OAuth tokens are held in memory only — never
   `localStorage`, never IndexedDB. Only a boolean "was connected" flag is persisted.
   **The one deliberate exception is the GitHub backup token**, which defaults to
   `localStorage`, because a credential the user must re-paste after every reload cannot
   do unattended saving and unattended saving is the entire feature. The exception is
   bounded three ways and must stay that way: the setup steps demand a *fine-grained*
   token scoped to *one private repository* with *Contents only*, the panel states plainly
   that anything on the origin can read it, and it can be turned off. Do not extend this
   licence to any other credential.
3. **Assume the browser profile is the only copy of the data.** The GitHub backup may not
   be set up, so anything that could destroy user records still needs care: prefer
   unlinking over deleting, and never delete local tasks in response to a remote change.
   The one place local records *are* deleted from a remote instruction is
   `applySnapshot`, and only for a `uid` the user explicitly deleted on another device.
4. **Renaming user-facing copy is free; renaming storage keys is not.** The database
   name, `localStorage` keys and remote list names identify existing data. If a name that
   is used for lookup has to change, keep matching the old one (see `LEGACY_INBOX_NAMES`
   in `engine.ts`), or an account synced by an older build re-imports its own inbox as a
   project.
5. **Explainability is a product requirement.** Every recommendation shows the points it
   earned and lost. Don't add a scoring signal without surfacing its reason string.
6. **Due dates are local-time `YYYY-MM-DD` strings — never call `toISOString()` on one.**
   `toISOString()` converts to UTC first, so anywhere west of Greenwich an afternoon pick
   comes back as the previous day. The owner is at UTC-07:00, where that is wrong for most
   of the waking day. Use the helpers in `src/dates.ts`, which work entirely in local
   time. For the same reason `addDays` uses `setDate` rather than adding milliseconds —
   daylight-saving days are 23 or 25 hours long.
7. **Task text is untrusted, and enriching it is display-only.** Titles and notes are free
   text that also arrives from Microsoft To Do and Google Tasks, so treat it the way you
   would any remote input. `src/linkify.ts` recognises exactly three shapes — an `http(s)`
   URL, a `www.` host and an email address — and every other string, `javascript:`
   included, stays inert text. Never render task text as HTML or markdown, never widen the
   set of allowed schemes, and never write the enriched form back: `linkify` returns
   segments whose text concatenates back to the input byte for byte, because that same
   string is what the `[fb]` footer codec parses and what gets pushed to a provider.
8. **Availability is a filter, never a score penalty.** A task that is blocked, not yet
   startable, or in the wrong place is *withheld* from recommendations, not scored down.
   Anything merely penalised will eventually surface at the top of a quiet board, which is
   exactly when the user is most likely to trust it. Whatever is withheld must be counted
   and explained on screen (`withheld()` in `recommender.ts`, `[data-withheld]` in the
   Focus panel) — a silent filter is indistinguishable from a bug.
9. **Elapsed time is derived from wall-clock stamps, never counted by an interval.** A
   session stores `runStartedAt` + `bankedMs` and computes elapsed time from `now`; the
   one-second interval exists only to trigger a repaint. Counting ticks would lose time to
   a throttled background tab, a sleeping laptop or a reload — and losing time is the one
   thing a timer must not do. Every function in `session.ts` takes `now` as an argument,
   so the maths is testable without waiting on real seconds.
10. **Local-only task fields must not bump `updatedAt`.** `spentMin` and `checklist` never
    reach a provider (`RemoteTaskFields` and `fieldsMatch` don't mention them). Touching
    `updatedAt` when they change would make `hasLocalEdits` true, waking the engine to
    compare every synced field, find them all identical, and push nothing — churn on every
    ticked checkbox. Write them with a `put()` that carries the old `updatedAt` through.
11. **The phone is a first-class target, so nothing may hide behind hover.** This is the
    owner's primary device. A control revealed by `group-hover` alone is permanently
    invisible on a touch screen, which is how the task rows once became uneditable there.
    Use `.reveal` (see *Mobile*), keep the layout free of horizontal overflow at 390px,
    and give small controls a `.tap` hit area.

## Stack

Vite 8 · React 19 · TypeScript 6 · Dexie 4 (IndexedDB) · Tailwind CSS v4 · oxlint.
No test framework — see *Tests* below.

## Commands

```bash
npm run dev        # HTTPS dev server on :5173 (HTTPS is required by both OAuth providers)
npm run dev:http   # plain HTTP, only if you don't need sync
npm run build      # tsc -b && vite build
npm run lint       # oxlint
npm test           # full browser suite
npm run test:prod  # smoke test the production bundle
npm run certs      # mkcert-based trusted local certs, removes the browser warning
```

`./tests/run.sh [suite]` runs suites directly; `SUITES_OVERRIDE=tests/foo.mjs ./tests/run.sh`
runs exactly one. The script starts a dev server and Chrome if they aren't already up.

### Typechecking gotcha

**`npx tsc --noEmit` silently does nothing here.** The root `tsconfig.json` is
solution-style (`"files": []` plus project references). Use `npx tsc -b --force` or
`npm run build` — anything else will report success on broken code.

## Layout

```
src/
  types.ts          data model (Task, Project, SyncLink, ProviderId, Domain…)
  db.ts             Dexie schema + versioned migrations + first-run seed
  recommender.ts    scoring and session planning — pure functions, no React
  availability.ts   can this task be started at all? blocked / deferred / wrong place,
                    plus the cycle guard behind the blocker picker. Pure; shared by the
                    recommender, the panels and TaskRow so they cannot disagree
  session.ts        the focus session: timer maths, localStorage persistence, checklist
                    helpers. Pure and clock-injectable — every function takes `now`
  dates.ts          local-time date helpers (see constraint 6) + monthGrid
  linkify.ts        display-only URL/email detection for task text
  index.css         every design token, dark then light — the whole theme lives here
  styles.ts         semantic colour maps (priority, focus, domain)
  ui.tsx            shared primitives (Card, Button, Field, Meta, Progress…)
  components/       UI panels
  sync/
    provider.ts     the SyncProvider seam + DEFAULT_DOMAIN + fieldsMatch()
    engine.ts       the sync algorithm, provider-neutral
    links.ts        all syncLinks access
    footer.ts       the [fb] notes-footer codec
    registry.ts     the list of services — add a row to support another
    mapping.ts graphClient.ts auth.ts msProvider.ts        Microsoft To Do
    googleMapping.ts googleClient.ts googleAuth.ts googleProvider.ts   Google Tasks
    fakeGraph.ts fakeGoogle.ts   in-memory servers used by the tests
  chat/
    client.ts       Anthropic Messages API over fetch + the browser-access header
    tools.ts        tool schemas and their executors (no delete tool, deliberately)
    useChat.ts      the tool-use loop and the system prompt
    key.ts          API key storage: memory by default, opt-in persist
    fakeClaude.ts   scriptable stand-in used by the tests
  backup/
    snapshot.ts     the JSON board format and every merge rule — pure, no Dexie
    store.ts        the Dexie side: readLocal, applySnapshot, recordGrave, backfillUids
    github.ts       the FileStore seam + the GitHub Contents API implementation
    config.ts       repo coordinates and token storage
    sync.ts         runBackup: read, merge, apply, write, retry on conflict
    useBackup.ts    debounced saving and refresh-on-focus
    fakeGitHub.ts   in-memory FileStore used by the tests
tests/              CDP-driven suites, driven by tests/lib.mjs
```

## Database

Current schema is **v5**. Dexie maps `version(n)` to IndexedDB version `n * 10`.

```
tasks     ++id, &uid, domain, projectId, status, priority, dueDate, focusLevel, createdAt,
          updatedAt, startDate, context, blockedBy
projects  ++id, &uid, domain, archived, name, updatedAt
graveyard ++id, &[kind+uid], deletedAt
tombstones ++id, provider, kind, [provider+kind]
syncState key
syncLinks ++id, &[provider+kind+localId], &[provider+kind+remoteId], [provider+kind], localId, provider
```

Rules:

- **Remote state never goes back onto `Task` or `Project`.** It lived there in v2 and had
  to be migrated out, because syncing to two services means a record needs an independent
  `(remoteId, remoteListId, remoteStamp, syncedAt)` *per provider*. That is what
  `syncLinks` is for, and `src/sync/links.ts` is the only module that touches it.
- **Every `Task` and `Project` has a `uid`, and it is the only id that means anything
  outside this browser.** `id` is a Dexie `++id`, so task 5 on the laptop and task 5 on
  the phone are unrelated records. Any new creation site must set `uid: newUid()`; the
  `creating` hook in `db.ts` is a safety net, not a licence to skip it.
- Adding a schema version means extending `tests/migration.mjs`, which rebuilds an old
  database for real and re-syncs on top of it. An `.upgrade()` is only needed when
  existing rows must change; v4 added indexes for optional fields, so it has none, while
  v5 backfills a `uid` onto every pre-existing row.
- **Deleting a task or project must also `recordGrave(kind, uid)`.** There are three such
  paths (`App.deleteTask`, `App.deleteProject`, and the remote-removal branch in
  `engine.ts`) and missing one means the record comes back from whichever device still has
  it. This is separate from `recordTombstone`, which is per-provider and short-lived.

### Dexie gotchas

- **`db.tasks.update()` silently ignores `undefined` values**, so it cannot clear a field.
  To clear one, `put()` the whole object: `db.tasks.put({ ...task, dueDate: undefined })`.
  To remove the key entirely, `.modify(t => { delete t.x })`.
- Only indexed fields are queryable. `db.tasks.where('title')` throws — `title` has no index.

## Sync

One algorithm in `engine.ts` runs against every service through the `SyncProvider`
interface. Adding a third service means: a client, a mapping, a provider adapter, an auth
module, a fake, and one row in `registry.ts`. It should mean **zero** changes to
`engine.ts`.

Invariants that exist for a reason — don't "simplify" them away:

- **Deletions are pushed before anything is pulled**, so a task deleted locally can't be
  resurrected by the same run.
- **Lists are adopted by name and tasks by title** when they have no link. Without this,
  "Reset links" duplicates the entire board on the next sync.
- **A list deleted remotely unlinks the project**, it does not delete local tasks.
- **Conflicts are last-write-wins**, counted and reported in the run summary.
- **Cursors and tombstones are namespaced per provider** (`${provider}:cursor:${listId}`).
- Deleting a record writes **one tombstone per linked provider**, then drops the links.

### Area (work vs personal) precedence

Two constants in `provider.ts` are the single source of truth, and the Sync tab reads the
same ones so the UI can't drift from the behaviour.

`DEFAULT_DOMAIN` — the area given to records the app has never seen before:
**Microsoft To Do → work, Google Tasks → personal**. It is the last resort. Precedence,
strongest first:

1. the `[fb]` footer's `area=`, when this app wrote the task;
2. the domain of the project the task lands in;
3. `DEFAULT_DOMAIN[provider]`.

`PUSH_DOMAINS` — which halves each service is allowed to hold: **Microsoft carries both,
Google carries personal only**.

A record that stops qualifying is **withdrawn**: deleted from that service and unlinked,
never deleted locally. Withdrawal is not optional tidiness — merely unlinking would leave
the record on the server for the next pull to re-adopt, and it would ping-pong forever.
See `withdrawList` / `withdrawTask` in `engine.ts`.

Two traps that already cost a debugging session:

- `reconcileLists` captures `remoteLists` **before** withdrawing anything, and its last
  loop turns unclaimed remote lists into local projects. A withdrawn list must be added to
  `claimed`, or it comes straight back as a duplicate local project and the next pull
  fails on a list that no longer exists.
- Adoption-by-title in `pullList` must skip local tasks this provider isn't allowed to
  hold, or it adopts them and then immediately withdraws them — deleting the user's
  remote copy.

A personal task filed under a work project has no list of its own in Google, so
`pushTasks` falls back to the inbox rather than erroring.

### Editing a project's area

`ProjectsPanel` has a per-row inline editor (name, colour, area). Changing the area calls
`editProject` in `App.tsx`, which moves the project **and every task in it** inside one
Dexie transaction. Never move the project alone: the recommender's area filter is hard, so
the tasks would vanish from the mode the user is looking in, and under the push split the
project and its contents would land on different services.

### The `[fb]` notes footer

Neither API has fields for estimate or focus, and Google has none for priority or tags
either, so they travel as one line appended to the task notes:

```
[fb] est=45m focus=deep prio=P2 area=work tags=writing,review ctx=laptop start=2026-03-01 wait=the%20quote
```

`footer.ts` is the shared codec (values are percent-encoded only when they contain
reserved characters, so the common case stays readable). It must stay a single line,
human-readable, rewritten in place rather than duplicated, and must never disturb the
user's own note text above it.

Three rules that are easy to break:

- **Only write a key the task actually uses.** The footer is parsed on whitespace and
  compared byte for byte by `fieldsMatch`, so emitting `ctx=` unconditionally would
  rewrite every task in both accounts on the next sync.
- **`blockedBy` is deliberately not synced.** It holds a local Dexie row id, which is
  meaningless — or actively wrong — on another device pulling the same account. The
  human-readable `wait=` note goes instead. Local-only fields survive a pull because the
  engine spreads `{ ...local, ...remote.fields }` (`engine.ts`), so a remote edit cannot
  erase one.
- **Any field that *is* synced must be added to both `RemoteTaskFields` and
  `fieldsMatch`** in `provider.ts`. `fieldsMatch` is a skip-if-equal optimisation: a field
  it doesn't compare can never be pushed, and the user's edit is silently lost.

### Microsoft To Do

- Real delta queries. Has `importance` (high/normal/low) and `categories`, so priority and
  tags are first-class; only estimate and focus need the footer.
- **Entra rejects `http://127.0.0.1` as a SPA redirect URI but accepts `http://localhost`.**
  The dev server runs HTTPS to sidestep the whole issue.
- MSAL is lazy-loaded and code-split — keep it out of the initial bundle;
  `tests/prod.mjs` asserts this.

### Google Tasks

- Fields are only `id, title, notes, due, status, completed, deleted, hidden, position,
  parent, updated, etag`. **No priority, no tags, no duration** — all four live in the footer.
- **No delta endpoint.** Incremental pulls use `updatedMin` + `showDeleted` + `showHidden`
  + `showCompleted`, paged with `pageToken`. The provider **rewinds the stored cursor by
  60 s** so an edit made during the previous request isn't missed.
- **`updateTask` uses PUT, not PATCH.** Sending `due: null` via PATCH is a long-standing
  no-op; a full update clears omitted fields properly.
- Due dates are **date-only** — a due time is kept locally but truncated on Google's copy.
- Rate limiting appears as 429 *and* as 403 with reason `rateLimitExceeded` /
  `userRateLimitExceeded` / `quotaExceeded` / `backendError`.
- Auth is the GIS token flow: set **Authorized JavaScript origins**, leave **redirect URIs
  empty**. There is no refresh token, so the token is renewed silently while the tab is open.
- A project in *Testing* only issues tokens to accounts listed under
  **Google Auth Platform → Audience → Test users**; anything else fails with
  `Error 403: access_denied`. That menu used to be called "OAuth consent screen".

## The GitHub board file

`src/backup/` keeps one JSON document in a private GitHub repository in step with the
local database. It is a **two-way merge, not an upload** — treating it as a backup would
mean the second device to run silently discards whatever the first one added, which is the
failure the feature exists to prevent.

```
snapshot.ts    the document format and every merge rule (pure, no Dexie, no network)
store.ts       the Dexie side: readLocal, applySnapshot, recordGrave, backfillUids
github.ts      the FileStore interface and its GitHub Contents API implementation
config.ts      repo coordinates, token storage, parseRepoInput
sync.ts        runBackup: read -> merge -> apply -> write, retried on conflict
fakeGitHub.ts  an in-memory FileStore with sha checking and an interpose hook
useBackup.ts   the React hook: debounced save, refresh on focus
```

Rules worth knowing before changing any of it:

- **`mergeSnapshots` must be commutative.** Both devices have to produce a byte-identical
  document from the same pair of inputs, or they ping-pong forever. That is why conflicts
  on an equal `updatedAt` break the tie on `JSON.stringify` rather than "prefer mine", and
  why the output is sorted by `uid`. `tests/backup.mjs` §20 pins this.
- **`sameBoard` ignores `savedAt`**, otherwise every run would see a difference and commit
  an identical board.
- **`applySnapshot` must not restamp `updatedAt`.** A pulled record that looks freshly
  edited bounces straight back out to every other device.
- **`applySnapshot` matches on `uid` and keeps the existing local `id`**, so focus
  sessions and `syncLinks` still resolve afterwards.
- **Deletions beat records, except a later edit.** Editing a task someone else deleted
  resurrects it *and drops the headstone*, so the two devices stop fighting. Headstones
  expire after `DELETION_HORIZON_MS` (90 days).
- **`syncLinks` are deliberately not in the file.** A link says how far *one browser* has
  reconciled with a provider. This is only safe because `engine.ts`'s `claimTwin` adopts
  an unlinked local task with a matching title instead of creating a duplicate.
- **Dangling `projectUid` / `blockedByUid` are stripped on merge**, and `applySnapshot`
  detaches local tasks whose project it just deleted. The snapshot's copy of such a task
  can be byte-identical to the local one, so the write pass will not notice on its own.

### GitHub API details

- The Contents API gives optimistic concurrency free: a write carries the blob `sha` it
  was based on. Omitting it overwrites unconditionally.
- **409** is GitHub's conflict; **422** is what it returns when the sha is missing for a
  file that exists. Both mean the same thing here.
- Past 1 MB the contents API stops inlining the blob and returns empty content — fall back
  to `GET /git/blobs/{sha}`, or an empty board is indistinguishable from a large one.
- `btoa` rejects code points >= 256, so text is UTF-8 encoded first, and chunked at
  `0x8000` to avoid a stack overflow in `String.fromCharCode(...)`. GitHub wraps its own
  base64 at 60 chars, so strip whitespace before `atob`.
- The file path is a path: encode each segment, never the slashes.

## jAIme (the chat assistant)

Lives in `src/chat/`, rendered by `src/components/ChatPanel.tsx` on its own tab. Talks to
the Anthropic Messages API **directly from the browser** — no backend, so constraint 1
still holds.

- **The header is the whole trick.** `anthropic-dangerous-direct-browser-access: true` in
  `client.ts` is what makes `api.anthropic.com` answer a cross-origin browser request.
  Without it the call fails CORS. Note this is Anthropic-specific: `api.openai.com` sends
  no permissive CORS headers, so the same approach does *not* work for OpenAI.
- **No SDK.** Raw `fetch`. The official SDK is Node-first and would add far more weight
  than the one header it sets. Don't add it.
- **The transport is injectable** (`ChatTransport`), exactly like the sync engine's
  clients. `fakeClaude.ts` is a scriptable stand-in; it must stay dev-only via
  `devHooks.ts` or `tests/prod.mjs` will fail its "fakes stay out of the bundle" check.
- **The key is memory-only by default**, with an explicit opt-in to persist. Never make
  persisting the default: it is a bearer credential with billing attached and, unlike an
  OAuth token, it never expires on its own.
- **`recommend` must call the real recommender.** The system prompt forbids the model from
  ranking tasks itself. If it freelanced, the chat and the Focus tab would disagree and
  the explainability requirement (constraint 5) would be silently broken.
- **There is no delete tool, and this is deliberate.** Deletion has no undo. If you add
  destructive tools later, they need an explicit confirmation step in the UI, not just a
  prompt instruction.
- **Tool failures are returned to the model**, not thrown. A bad task id is something it
  recovers from by looking the task up; throwing would abandon the turn.
- `MAX_STEPS` in `useChat.ts` caps the tool loop. A loop that cannot terminate is billed
  to the user one request at a time.

## Recommender

`recommender.ts` is pure — no React, no Dexie, no `Date.now()` passed implicitly. Keep it
that way so scoring stays trivially testable. It scores only what `availability.ts` says
can actually be started; see constraint 8.

Four deliberate design choices:

- **Focus mismatch is penalised harder than a match is rewarded** (−24 per level short vs
  +22 for an exact match). Attempting deep work while depleted is the most common way a
  session fails, so the engine actively steers away from it.
- **A task with no context is available everywhere and scores nothing either way.** The
  field has to stay opt-in — filling it in on three tasks must not bury the other forty.
- **A dangling `blockedBy` (its blocker was deleted) means *not* blocked.** Hiding a task
  forever behind a reference the user can no longer see or clear is the worst available
  failure mode. `App.deleteTask` also clears dependents' `blockedBy` in the same
  transaction, so the dangling case should only ever arise from an import.
- **The session plan is greedy, not an optimal knapsack.** Ordering stays predictable and
  explainable, and the time estimates are far too rough for exact packing to mean anything.

## Focus session

`session.ts` + `components/FocusSession.tsx`. Pressing **Start** begins a session; `App`
then takes an **early `return` before its main render**, replacing the *entire* app —
header, tabs, stats, footer, backlog. Replacing only `<main>` would leave the tabs on
screen, and then nothing has actually been removed, which is the whole feature.

- **`TaskRow` takes an optional `onStart`**, so Start lives on every row the app shows —
  the ranked alternatives, the Tasks tab, and a project's task list — as well as on the
  recommendation card and each session-plan item in `FocusPanel`. It is hidden for tasks
  that are **done or blocked**: the session screen ends a session the moment you mark its
  task blocked, so offering to start an already-blocked one would contradict that. A
  *deferred* task still offers it — that date is one the user set and may reconsider.
- Every Start control carries `data-start-task="<title>"`. In the Focus tab the top card's
  own button comes first in DOM order, so `main button` matching on `Start` still finds the
  recommendation rather than an alternative.

- Persisted at **`pp.session.v1`** in `localStorage`, not IndexedDB: it is ephemeral,
  device-local UI state. Only the *outcome* (`spentMin`) is written to the task.
- See constraint 9 for the timer, and constraint 10 for why `spentMin` and `checklist`
  don't bump `updatedAt`.
- **The countdown goes negative rather than freezing at zero**, flipping to `+m:ss` in
  `text-warn`. Freezing hides the one thing the timer has to say at that moment.
- **`extendSession` also rewrites `task.estimateMin`.** An estimate left wrong makes every
  future plan built on it wrong the same way. That field *is* synced, so it bumps
  `updatedAt` — unlike the two local-only ones.
- **`sessionIsStale` clears a session whose task is gone or done.** A clock ticking against
  nothing is unrecoverable from the UI, because the UI you would need is the one it is
  covering.
- **The checklist is local-only by design.** To Do's checklist items are a separate
  sub-resource and Google's "subtasks" are top-level tasks, so neither maps; flattening
  into the notes would fight the `[fb]` footer for space. `TaskRow` shows `n/m steps`
  (`data-task-steps`) so a checklist is at least visible from the board.
- **"I'm stuck" offers three exits, not a dead end**: mark blocked (ends the session and
  parks the task with a `blockedNote`), break it down (stays *in* the session and focuses
  the checklist input), or swap to something smaller — taken from the same `recommend()`
  ranking, so a swap is still a recommendation.
- **A swap replaces the task under the same mounted component**, so `FocusSession` resets
  its `stuck` menu on `session.taskId` change. Without that the menu hangs over the new task.

## Tests

There is no test framework. Suites in `tests/` drive real headless Chrome over the DevTools
Protocol, so IndexedDB, Dexie transactions and React rendering are exercised for real
rather than mocked. `tests/lib.mjs` provides `connect()` → `{ js, errors, close }`.

Suites, in run order (`migration` must stay first — it rebuilds the database from scratch):

| Suite | Covers |
| --- | --- |
| `migration.mjs` | the v2 → v5 upgrade, replayed against a real old database |
| `engine.mjs` | the sync algorithm against the Microsoft fake |
| `google.mjs` | the same algorithm against the Google fake |
| `dual.mjs` | one board mirrored to both services at once |
| `syncui.mjs` | the Sync tab, lazy-loaded SDKs, persistence |
| `projects.mjs` | expanding a project to see its tasks, and the inline project editor |
| `chat.mjs` | jAIme's tools, the key gate, and conversations via the Claude fake |
| `dates.mjs` | the calendar picker and the local-time date helpers behind it |
| `links.mjs` | clickable links in task text, and the schemes that must never render |
| `theme.mjs` | the light/dark flip, and measured contrast of every text node in both |
| `fields.mjs` | context, blocked and earliest-start: semantics, filtering, both sync round-trips, jAIme, and the on-screen badges |
| `session.mjs` | the focus session: timer maths, Start removing the board, reload survival, pause/extend/checklist, every "I'm stuck" branch, starting from a row on any tab, and that none of it syncs |
| `backup.mjs` | the GitHub board file: portable ids, every merge and deletion rule, the write race, export/import round trip, and the real client's requests against a stubbed `fetch` |
| `prod.mjs` | the production bundle (run separately via `npm run test:prod`) |

Conventions:

- Chat is tested against `fakeClaude.ts`, never a real key. Tool executors are called
  directly (fast, precise) *and* driven through the UI (proves the loop) — splitting the
  two stops a tool bug from looking like a loop bug.
- `SectionTitle` uppercases via CSS and `innerText` reflects that, so assert on headings
  case-insensitively (`.toUpperCase().includes('CONNECT JAIME')`).
- **Dexie keeps its autoincrement counter across `clear()`**, so seeded ids are not `1..n`.
  Capture the real ids from the fixture instead of hardcoding them.
- Assert on rendered *colour*, never on class names — a class list says nothing about what
  the pixel ends up being once tokens, `color-mix()` and translucent ancestors are applied.
- **Prefer a `data-*` attribute as a test handle** over a Tailwind class or an `innerText`
  substring: `[data-task-title]`, `[data-task-context]`, `[data-task-start]`,
  `[data-task-blocked]`, `[data-withheld]`, `[data-priority-rail]`, `[data-session]`,
  `[data-session-clock]`, `[data-checklist-item]`, `[data-stuck-menu]`. Substring matching
  in particular is a trap here — a blocked row *quotes the title of the task blocking it*,
  so `rows.find(el => el.innerText.includes(title))` will happily find the wrong row.
- **A UI suite that clears `projects` re-seeds the demo board on the next reload**
  (`seedIfEmpty` runs whenever the table is empty). If a suite navigates after a reset,
  insert a placeholder project first or it will be asserting against the seed data too.
- **`window.__f`-style page harnesses die on `Page.navigate`.** Re-install after every
  reload. Also, `Runtime.evaluate` has no top-level `await` — wrap in an async IIFE.
- **Match a button by its first line, not its whole `innerText`**, wherever it carries an
  explanatory sub-line (every entry in the "I'm stuck" menu does). Exact equality silently
  finds nothing, which surfaces as "no button labelled …" rather than as a wrong assertion.
- **Setting a React-controlled input from CDP needs the native setter**, then an `input`
  event: `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i, s)`.
  Assigning `i.value` directly is swallowed by React's value tracker. A `<select>` filter
  needs the same treatment with `HTMLSelectElement.prototype` and a `change` event.
- **Never put an assertion behind an `if`.** A guard like `if (found) eq(...)` turns a
  broken selector into a silently skipped test, and the totals still read green. Throw when
  the fixture isn't there instead.
- **Rewriting `pp.session.v1` from a test does not move the running clock.** The mounted
  component is still holding the stamp it started with, so anything that ages a session
  mid-flight has to reload the page for the change to take effect.
- **Clock assertions need a one-second tolerance** (`/^(45:00|44:5\d)$/`). A real second
  can elapse between the click and the read, and pinning the exact face makes the suite
  fail on a slow machine and nowhere else.
- **Date tests pin explicit calendar dates in the future** (2026–2028) rather than
  computing from "now", so a suite that passes today still passes next March. Keep the
  daylight-saving and month-end cases — they are the ones that catch real regressions.
- Sync logic is tested against `fakeGraph.ts` / `fakeGoogle.ts`, never a real account. Both
  fakes implement real delta / `updatedMin` semantics, including deletion tombstones.
- Every behaviour change needs an assertion that would have failed before it. If a new test
  passes against the old code, it isn't testing the change.
- **Never write `db.tasks.update(id, { updatedAt: Date.now() })` straight after a sync.**
  `hasLocalEdits` is `updatedAt > syncedAt` — strict on purpose, so a record the pull just
  wrote isn't echoed back — which means an edit made inside the same millisecond reads as
  clean. Use the harness's `h.edit(id, patch)` / `h.replace(id, patch)`, which wait a tick
  first. This was a latent flake in five tests that only surfaced when unrelated timing
  shifted.
- **Regexes in the Node half of a test file need single backslashes** (`/\[fb\]/`).
  Double-escaping them matches a literal backslash and produces a silent false pass.
- Fixtures in `google.mjs` and `dual.mjs` default to `domain: 'personal'`, because a work
  record is never pushed to Google and the test would be asserting against an empty account.
- Testing "local is newer" against Google needs
  `new FakeGoogleClient({ startTime: Date.now() - 3600000 })`. Rewinding with
  `advanceClock(-…)` instead pushes the edited task outside the `updatedMin` window, so it
  never comes back and the test proves nothing.

## Environment notes (macOS)

- `erasableSyntaxOnly` is on: **TypeScript parameter properties are not allowed.**
- macOS has no `timeout(1)`.
- Chrome `--headless --dump-dom` hangs; use `--headless=new` plus CDP over Node's global
  `WebSocket`. Binary at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.
- `@vitejs/plugin-basic-ssl` affects `vite preview` too, so production tests run with `HTTPS=0`.
- Ports: dev `5173`, test dev server `5174`, preview `4178`.

## Visual design

Tailwind v4, configured entirely through `@theme` tokens in `src/index.css` — there is no
`tailwind.config.js`. Shared primitives live in `src/ui.tsx`, semantic colour maps in
`src/styles.ts`.

**The one rule that matters: colour means urgency, not category.**

An earlier version gave every attribute its own bright pill, so a P1 due today and a
`#research` tag competed on equal terms and a task list read as noise. The current
treatment:

- **Priority** drives a saturation ramp and a 3px rail down the left edge of the row
  (`PRIORITY_RAIL`). P1 is rose and genuinely loud; P4 is barely visible.
- **Due dates** take colour only when overdue (rose) or due today/tomorrow (amber).
  Anything further out is plain metadata.
- **Everything descriptive** — duration, focus, area, project, tags — renders in one quiet
  dot-separated line (`Meta` / `MetaDot`), not as pills.
- **Dots, not badges**, for identity: project colour and focus level (`Dot`, `FOCUS_DOT`).

Other conventions:

- **Lists are divided, not nested.** A `Card` holds rows separated by
  `divide-y divide-line-soft`. Don't put bordered boxes inside bordered boxes.
- **Don't repeat the container's own label.** Project rows under the `WORK` heading do not
  also carry a `work` badge.
- **`SectionTitle` stays uppercase**, and several tests match those strings
  (`'ALL TASKS'`, `'JAIME RECOMMENDS'`, `'MICROSOFT TO DO'`) — changing the casing
  breaks them.
- **Checkboxes and the range slider are drawn from scratch** in `index.css`. Native
  checkboxes render as white boxes on a dark surface and `accent-color` only tints the
  *checked* fill; Chrome likewise stops honouring `color-scheme` for a range's unfilled
  track once `accent-color` is set. Both remain real inputs, which the tests drive. The
  slider's fill is a gradient driven by a `--pct` custom property set inline by the
  component.
- **Numbers that change in place carry `.tnum`** (tabular figures) so counters and grids
  don't shuffle sideways.
- Restyling is safe as long as **text content and aria hooks are preserved** — the suites
  assert almost entirely on `innerText` and `aria-label`. Prefer a `data-` attribute over a
  Tailwind class when a test needs a handle (see `[data-month-label]`).

`tests/shots.mjs` is a dev helper, not a suite: it seeds a representative board and writes
a screenshot of every tab (plus the task dialog and its calendar) to `SHOT_DIR` (default
`/tmp/shots`) so a redesign can actually be looked at. `SHOT_SCHEME=light|dark` picks the
theme. Run it against the test server with Chrome already listening on CDP.

### Deployment and the base path

The app can be served from the root of an origin (the default) or from a subfolder, chosen
at build time with `BASE_PATH=/nextwise/ npm run build`. `vite.config.ts` normalises the
value to a leading and trailing slash, because Vite misbehaves quietly without them.

Three things follow from a build that isn't at the root, and all of them are already
handled — don't undo them:

- **Nothing in `public/` may use an absolute URL.** `manifest.webmanifest` uses `"."` for
  `start_url` and `scope` and `"./icons/…"` for its icons. Relative manifest URLs resolve
  against the manifest's own address, so the same file is correct at any depth. Vite
  rewrites `/…` references inside `index.html`, but it does **not** look inside files it
  merely copies.
- **`appUrl()` in `sync/auth.ts` is the redirect URI**, not `location.origin`. When
  `BASE_URL` is `/` it returns the bare origin — deliberately, byte for byte, because Entra
  matches redirect URIs exactly and treats `https://host` and `https://host/` as two
  different registrations, so "tidying" it would break every existing setup silently. For a
  subfolder it returns `https://host/folder/`, keeping the trailing slash: hosts answer the
  slashless form with a 301, and following it would drop the fragment MSAL hands back.
  `tests/syncui.mjs` §1 guards both shapes.
- **Google stays on the bare origin.** `SETUP.gtasks.uri` is `location.origin`, since an
  authorized JavaScript origin cannot contain a path. Only Microsoft uses `appUrl()`.

There is no client-side router, so deployment needs no rewrite rules.

### Mobile

The app has to work at **390px** with a coarse pointer. Three utilities in `index.css`
carry that, and new UI should reuse them rather than reinvent the behaviour:

- **`.reveal`** — the replacement for `opacity-0 group-hover:opacity-100`. That pattern is
  a touch trap: with no hover, the controls are permanently invisible and the row becomes
  unusable. `.reveal` defaults to `opacity: 1` and only hides inside
  `@media (hover: hover) and (pointer: fine)`, where it also handles `:focus-within`.
  **Never write a bare `group-hover` opacity reveal.**
- **`.tap`** — an `::after` overlay that pads a small control out to a 40px hit area
  without changing its visual size. Use it on anything under ~32px (row checkbox, the
  checklist remove `×`).
- **`.no-scrollbar`** — for a horizontally scrollable strip, currently the tab bar.

Two layout rules:

- **A grid track must never be `auto` if its children can exceed it.** `min-width: auto`
  on grid items lets an `auto` track size to its items' min-content and overflow its own
  container — this produced a horizontal scroll that took three rounds to find, because
  the culprit was a *sibling* column, not the card being measured. Use Tailwind's
  `grid-cols-1` (`repeat(1, minmax(0, 1fr))`) and write explicit tracks as
  `[320px_minmax(0,1fr)]`, never `[320px_1fr]`.
- **Rows wrap, they don't shrink.** `TaskRow` is `flex-wrap`, and the action cluster is
  `w-full justify-end sm:w-auto sm:justify-start`, so it drops to its own line under 640px
  and stays inline above it.

`body` carries `env(safe-area-inset-*)` padding, paired with `viewport-fit=cover` in
`index.html`. PWA assets are `public/manifest.webmanifest` plus `public/icons/*`, which are
committed, not generated at build time — the build must not need a browser. Regenerate them
with `node scripts/make-icons.mjs` (its own Chrome on port 9226) after editing
`public/icon.svg`. There is no service worker.

**Measuring it:** headless Chrome reports a fine pointer even with device metrics
overridden, so `.reveal` stays hidden and the bug hides from you. You must also send
`Emulation.setTouchEmulationEnabled {enabled: true}` *and*
`Emulation.setEmulatedMedia` with features `hover: none` + `pointer: coarse`. Verify with
`matchMedia('(hover: hover)').matches === false` before trusting any measurement.

### Theming

Light and dark are chosen from `prefers-color-scheme`; there is no toggle and no stored
preference. The whole mechanism is CSS variables:

1. `@theme { --color-*: … }` in `src/index.css` defines the **dark** palette and is what
   generates the utilities. Tailwind compiles `bg-ink-800` to
   `background-color: var(--color-ink-800)`, and `bg-ink-800/70` to a `color-mix()` over
   the same variable.
2. `@media (prefers-color-scheme: light) { :root { --color-*: … } }` **redefines those
   variables**, so every utility in the app flips without a single extra class.

Tailwind also emits a literal-hex copy of each opacity-modified utility as a fallback, but
it is wrapped in `@supports (color: color-mix(...))` and loses to the `var()` rule in any
browser that supports `color-mix`. Don't be alarmed by hardcoded dark hexes in the built
CSS.

**Scales keep their meaning, not their luminance.** `ink-900` is always the page and
`ink-800` the raised card above it; `mist-200` is always the most prominent secondary text
and `mist-500` the faintest. Only the hex values invert.

**Never hardcode a colour in a component.** Reach for:

| Need | Token |
| --- | --- |
| Page / card / raised surfaces | `ink-900`, `ink-850`, `ink-800`, `ink-700`, `ink-600` |
| Primary text | `fg` |
| Secondary text, strongest to faintest | `mist-200`, `mist-300`, `mist-400`, `mist-500` |
| Hairlines | `line`, `line-strong`, `line-soft` |
| Translucent lift: resting / hover / selected | `raise-1`, `raise-2`, `raise-3` |
| Modal backdrop | `scrim` |
| Meaningful text colour | `danger`, `warn`, `good`, `deep`, `work`, `personal` |
| Priority rails | `rail-1` … `rail-4` |
| Elevation | the `.elev-card` / `.elev-pop` classes, not a `shadow-black/x` utility |

The only legitimate `text-white` left in `src/` is text sitting **on an accent fill**
(the primary button, the logo mark, the selected calendar day, the active focus preset) —
white is correct there in both themes. Four occurrences; there should never be a fifth.

Two subtleties worth knowing:

- **Rails have their own tokens rather than reusing `danger`/`warn`.** Text must clear
  4.5:1 on the card while a rail only needs 3:1 and must *not* shout, so the two pull in
  opposite directions — and amber simply cannot do both on white. Alpha is baked into the
  rail tokens per theme to keep the P1-loud/P4-silent ramp reading the same either way.
- **A translucent accent fill is not a safe disabled state.** `bg-accent-500/30` with
  `text-white/50` looks fine on black and becomes pale-lavender-on-white in light mode.
  Disabled controls use a neutral `raise-2` chip with `mist-500` text.

`tests/theme.mjs` enforces all of this by measuring what actually renders: it reads
`getComputedStyle` (which has already resolved `var()` and `color-mix()`), composites every
translucent ancestor down to an opaque colour, and computes real WCAG contrast in both
schemes. Two traps it has already caught, and which will catch you too:

- **Colours must be rasterised, not regex-parsed.** Tailwind v4's palette is authored in
  oklch, and Chrome serialises an opacity-modified colour as
  `oklab(0.5 -0.003 -0.035 / 0.6)`. Reading those numbers as RGB channels yields
  plausible-looking, completely wrong ratios. The suite paints the colour into a 1x1
  canvas and reads the sRGB bytes back.
- **Headless Chrome defaults to light**, so unless a suite calls
  `Emulation.setEmulatedMedia`, it is now exercising the *light* theme.

## Style

Comment the *why*, not the *what*. The codebase deliberately explains non-obvious
decisions (why deletions go first, why the cursor rewinds 60 s) and leaves ordinary code
uncommented. Match that.
