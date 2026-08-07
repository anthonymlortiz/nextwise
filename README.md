# Nextwise

A browser-only productivity tool that doesn't just store your to-dos — it tells you
**which one to do right now** based on how much time you have, how sharp you feel,
and whether you're in work or personal mode.

No backend, no accounts, no server. Everything lives in your browser's IndexedDB.

## Why it's different

Most to-do apps show you a flat list and leave the hardest part — deciding what to
actually start — up to you. **jAIme**, the assistant on the first tab, asks three
questions:

1. **How long have you got?** (5 min … 4 hours)
2. **How's your focus?** Drained / Okay / Sharp
3. **Work, personal, or both?**

…then ranks every open task against that context, shows a single clear answer, and
packs a session plan for the time available.

The same task list produces genuinely different advice:

| Context (1h30m window) | Top recommendation |
| --- | --- |
| Sharp | Write migration design doc *(deep, 90 min)* |
| Okay | Screen 3 candidate resumes *(medium, overdue)* |
| Drained | Book dentist appointment *(shallow, 10 min)* |

## Features

- **Priorities** — P1 (critical) through P4 (low)
- **Estimated duration** — with quick presets; drives all time-budget fitting
- **Work vs personal split** — a hard filter, so personal noise never intrudes on work mode
- **Projects within each area** — e.g. *Platform Migration* under Work, *Health* under Personal.
  Expand any project to see, complete, edit and add its tasks in place
- **Editable projects** — rename, recolour, or move one between work and personal.
  Changing the area moves its tasks with it, so a project and its contents never end up
  on opposite sides of the board (or of the sync split)
- **Focus level per task** — deep / medium / shallow cognitive demand
- **Context per task** — laptop, phone, home, office or errand. Tell the Focus tab where
  you are and it stops suggesting work you can't physically do from there
- **Blocked / waiting-on status** — either point a task at the task that's blocking it, or
  just write down what you're waiting for. Blocked tasks are held out of recommendations
  until they're released
- **Earliest start ("not before")** — park a task until the day it actually becomes
  doable, without it cluttering the board in the meantime
- **Due dates** with overdue tracking, set from a built-in calendar with shortcuts
  (*Today*, *Tomorrow*, *This weekend*, *Next Monday*, *In a week*)
- **Explainable scoring** — every recommendation shows the points it earned and lost,
  and the Focus tab says how many tasks it held back and why
- **Session plan** — greedily packs your window with the best-scoring tasks that fit
- **A true focus session** — press Start and the backlog disappears, leaving one task, a
  timer, its notes and a checklist. See [The focus session](#the-focus-session)
- **Tags, notes, search, and sorting**
- **jAIme, a chat assistant** that can read your board, add and edit tasks, set your
  context and explain what to work on — see [Talking to jAIme](#talking-to-jaime)
- **Two-way sync with Microsoft To Do and Google Tasks** — either or both at once;
  see [Syncing](#syncing-with-microsoft-to-do-and-google-tasks)
- **Your board in your own private GitHub repo** — one JSON file, merged both ways, so
  the data isn't trapped in one browser and follows you between devices. See
  [Keeping the board in a GitHub repo](#keeping-the-board-in-a-github-repo)
- **JSON export / import** for backup and moving between machines

## The interface

A low-chrome layout built on Tailwind v4 tokens, with one governing rule: **colour means
urgency, not category.**

Priority drives a saturation ramp and a thin rail down the left edge of every task, so a
P1 is the loudest thing on screen and a P4 is nearly silent. Due dates take colour only
when they're overdue or land today or tomorrow. Everything else a task carries — duration,
focus, area, project, tags — sits in one quiet dot-separated line rather than competing as
a row of coloured pills. Lists are separated by hairline dividers instead of nesting
bordered cards inside bordered cards.

**URLs and email addresses in a task's title or notes are clickable**, opening in a new
tab. Only `http`, `https` and `mailto` links are ever produced, so a note synced in from
another service can't turn into something that runs when clicked. The text itself is never
rewritten — what you typed is what is stored and what is pushed to Microsoft or Google.

**Light and dark both ship**, chosen automatically from your operating system's appearance
setting — there is no toggle to forget about, and switching your Mac or Windows theme
flips the app on the spot. Every colour resolves through a semantic token rather than a
literal, so both themes stay in step, and `tests/theme.mjs` measures the rendered contrast
of every piece of on-screen text in each of them.

## How the recommendation works

Before anything is scored, tasks that simply **can't be done right now** are removed:
blocked ones, ones whose earliest start date hasn't arrived, and ones whose context
doesn't match where you say you are. They aren't scored down — they're set aside, and the
Focus tab tells you how many went and for which reason, so a quiet board never quietly
promotes something you can't act on.

Everything that survives is scored, and the reasons are shown in the UI so nothing is a
black box.

| Signal | Effect |
| --- | --- |
| Priority | P1 +45, P2 +30, P3 +18, P4 +8 |
| Due date | Overdue +40 (plus up to +20 more), today +38, tomorrow +26, ≤3d +16, ≤7d +9 |
| Time fit | Fits the window: +8 to +25, scaled so tasks that use the slot well rank higher |
| Doesn't fit | −35 or worse, so an oversized task never leads the list |
| Focus match | Exact match +22; more focus than needed +9; **not enough focus −24 per level** |
| Context match | +10 when the task's context is exactly where you are |
| Staleness | Up to +12 as a task ages, so nothing rots forgotten |

Four design decisions worth knowing:

- **Focus mismatch is penalised harder than a match is rewarded.** Attempting deep work
  while depleted is the most common way a work session fails, so the engine actively
  steers you away from it.
- **Availability is a filter, never a penalty.** A blocked or not-yet-startable task
  scored merely *low* would eventually float to the top of a quiet board. It's excluded
  outright instead, and accounted for separately.
- **A task with no context is available everywhere** and earns nothing either way, so the
  field stays opt-in — filling in three tasks doesn't bury the other forty.
- **The session plan is greedy, not an optimal knapsack.** Ordering stays predictable and
  explainable, and time estimates are too rough for exact packing to mean anything.

## The focus session

A recommendation is only half the job. Press **Start** — on the recommended task, on any
task in the session plan, on a ranked alternative, or on any row in the Tasks tab or a
project — and the app gets out of the way: the header, the tabs, the stats and the entire
backlog are replaced by a single screen holding only what you need to actually do the thing.

- **The current task**, its notes, and its links — still clickable, so the runbook you
  wrote down is one tap away instead of behind a tab switch.
- **A countdown from your estimate.** When you run past it the clock doesn't freeze at
  zero, it flips to counting *up* in amber. The one moment a timer has something urgent to
  say is the moment you've overrun.
- **A small checklist.** Add steps as you go; the row on the board later shows `2/5 steps`
  so a part-finished task doesn't look identical to an untouched one.
- **Pause** banks the time so far and stops the clock.
- **Complete** finishes the task and returns you to the board.
- **This is taking longer** adds ten minutes to the plan *and corrects the task's
  estimate*. An estimate left wrong makes every future plan built on it wrong the same way.
- **I'm stuck** offers three ways out rather than a dead end: mark it blocked (with what
  you're waiting on, which parks it properly), break it down (drops you into the checklist
  without leaving the session), or swap to something smaller — drawn from the same ranking,
  so a swap is still a recommendation rather than an arbitrary jump.

Time is never counted by a ticking interval. The session stores wall-clock stamps and
derives elapsed time from them, so a backgrounded tab, a locked laptop or a full reload
costs you a repaint and never a minute. Leaving mid-session — deliberately, or by closing
the tab — banks what you spent onto the task and leaves it open.

**Start is offered on every open, unblocked task**, and nowhere else. A completed task has
nothing to start; a blocked one would put a clock against something that can't move, which
is exactly what the session screen refuses to do when you mark a task blocked from inside it.

**The session is device-local.** It lives in `localStorage`, and so do the two fields it
writes: `spentMin` and `checklist`. Neither is sent to Microsoft or Google — To Do's
checklist items are a separate sub-resource and Google's "subtasks" are top-level tasks,
so neither maps cleanly, and flattening them into the notes would fight the sync footer
for space. Local-only writes also deliberately don't touch `updatedAt`, so ticking a
checkbox never wakes the sync engine to push a task whose synced fields haven't changed.

## On your phone

The layout works down to a 390px viewport, and the app ships a web manifest, so you can
add it to your home screen and it launches without browser chrome.

Two things are different on a touch device:

- **Row actions are always visible.** On a desktop, Start / Edit / Delete fade in when you
  hover a row. A phone has no hover, so they stay on permanently — the reveal only applies
  under `(hover: hover) and (pointer: fine)`.
- **Actions drop to their own line** below the task, and the tab bar scrolls sideways
  rather than wrapping.

There is no service worker yet, so an installed copy still needs the network to load.

**Your phone and your laptop are separate boards.** All data lives in each browser's
IndexedDB, so nothing crosses over by itself. The only bridge is Google Tasks or
Microsoft To Do: connect both devices to the same account and the synced fields will
match. Everything local-only — blockers, checklists, time spent, focus sessions and your
saved availability — stays on the device that created it.

## Putting it online

`npm run build` writes a self-contained static site to `dist/` (about 900 kB, ~205 kB over
the wire). Upload that folder to any static host. There is no server, no build step to run
remotely and no environment variables to set.

It has to be served over **HTTPS**: Microsoft only issues tokens to an HTTPS redirect URI
and Google only to a secure origin. Without it the app still runs, but sync can't connect.

There's no client-side router, so you don't need SPA rewrite rules — every request maps to
a real file.

### Hosting it in a subfolder

The build assumes it owns the root of an origin. To serve it from a subfolder of a site you
already have, name that folder at build time:

```bash
BASE_PATH=/nextwise/ npm run build      # then upload dist/ to /nextwise/ on your host
npm run preview                          # check it locally at http://localhost:4178/nextwise/
```

The path is baked into the bundle, so it has to match where you actually put the files. A
default `npm run build` is still the right thing for a root domain or subdomain.

### Registering the address

Open the **Sync** tab on the deployed site. Each provider shows the exact string to
register, which will now be your new URL rather than `localhost`:

- **Microsoft** — Entra → your app registration → *Authentication* → add the shown
  **redirect URI** as a *Single-page application* platform. In a subfolder build this
  includes the folder and its trailing slash; copy it verbatim, because Entra matches
  redirect URIs character for character. Keep the localhost entry if you still use the app
  on your laptop; a registration can hold several.
- **Google** — Cloud Console → *Credentials* → your OAuth client → add the shown
  **authorized JavaScript origin**. This one is always the bare origin with no path, even
  in a subfolder build, because an origin can't carry one.

The deployed site holds no data of its own — every board lives in the browser that created
it — so the URL doesn't need to be secret or password-protected. Anyone who opens it gets
an empty copy.

## Running it

```bash
npm install
npm run dev      # https://localhost:5173
```

The dev server uses **HTTPS**, because Microsoft Entra requires an HTTPS redirect
URI and Google only issues tokens to secure origins. Out of the box the certificate
is self-signed, so your browser asks you to accept it once per profile. To get rid of
that warning:

```bash
brew install mkcert nss   # nss is only needed for Firefox
npm run certs             # trusts a local CA, writes certs/
```

Other commands:

```bash
npm run build    # typecheck + production bundle into dist/
npm run preview  # serve the production build
npm run lint     # oxlint
npm test         # sync engine + UI tests in headless Chrome
npm run test:prod # smoke test the production bundle
npm run dev:http # plain HTTP, if you don't need sync
```

### Tests

There's no test framework here. The suites in `tests/` drive a real headless Chrome
over the DevTools Protocol, so IndexedDB, Dexie transactions and React rendering are
exercised for real instead of mocked. `npm test` starts a dev server and Chrome if they
aren't already running.

- `tests/migration.mjs` — 38 assertions rebuilding a pre-multi-provider (v2) database and
  checking the upgrade to v5 harvests inline link state, adds the availability indexes and
  gives every existing record a portable id, without losing or duplicating data.
- `tests/engine.mjs` — 68 assertions covering the sync algorithm end to end (first sync,
  no-op re-sync, both conflict directions, deletes in either direction, remote-created
  tasks, list adoption, cross-project moves, full metadata round-trip). It runs against
  `src/sync/fakeGraph.ts`, an in-memory Graph server with real delta semantics, so no
  Azure tenant is needed.
- `tests/google.mjs` — 80 assertions running the same algorithm against
  `src/sync/fakeGoogle.ts`, including `updatedMin` windows, deleted-task tombstones and
  the richer notes footer.
- `tests/dual.mjs` — 95 assertions with one board mirrored to both services at once:
  independent link state, the work/personal split and withdrawal when a task or project is
  re-filed, and re-linking after a reset without duplicating anything.
- `tests/syncui.mjs` — 77 assertions on the Sync tab, lazy-loaded auth SDKs, persistence,
  and the GitHub backup card's setup, validation and token handling.
- `tests/projects.mjs` — 40 assertions on expanding projects to view their tasks, and on
  the inline project editor (rename, recolour, and moving a project between work and
  personal with its tasks following).
- `tests/chat.mjs` — 55 assertions on jAIme: every tool against a real database, the
  key gate, and full conversations driven by `src/chat/fakeClaude.ts`, a scripted
  stand-in for the Anthropic API so the loop is testable without a key or a network.
- `tests/dates.mjs` — 60 assertions on the calendar picker and the date helpers behind
  it, including days that cross a daylight-saving boundary, month-end clamping and a
  guard that dates never round-trip through UTC.
- `tests/links.mjs` — 46 assertions on turning URLs in a task into links: what counts as
  one, how trailing punctuation and brackets are handled, and that no scheme other than
  `http`, `https` or `mailto` can ever come out the far end.
- `tests/theme.mjs` — 44 assertions that the light theme actually takes effect and that
  nothing is illegible in either one. It reads back the rendered colours, composites the
  translucent layers and checks real WCAG contrast, so a stray hardcoded colour that
  survives the flip is caught as white-on-white rather than passing a class-name check.
- `tests/fields.mjs` — 91 assertions on context, blocked status and earliest start:
  what counts as blocked, that a dangling blocker reference frees a task rather than
  trapping it, cycle refusal, the recommender withholding rather than demoting, both
  sync round-trips, jAIme's tools, and the on-screen badges and filters.
- `tests/session.mjs` — 101 assertions on the focus session: the timer maths against an
  injected clock, that Start really does remove the tabs and the backlog, surviving a
  reload without double-counting the time the tab was shut, pause, extend, the checklist,
  every branch of "I'm stuck", banking time on the way out, starting from a row on any
  tab, and that none of it leaks to a sync provider.
- `tests/backup.mjs` — 95 assertions on the GitHub board file. Most of it is about what
  two devices can do to the same record between two saves: the same task edited twice, an
  edit racing a deletion, two writes landing on the same blob, and a merge that has to
  come out identical whichever side runs it. It also covers the export/import round trip
  and, with `fetch` stubbed, the exact requests the real client sends to GitHub.
- `tests/prod.mjs` — checks the production bundle mounts, strips dev hooks, and doesn't
  pull MSAL on first load.

## Talking to jAIme

The **jAIme** tab is a chat box that can actually operate the board: it adds and edits
tasks, creates projects, sets your available time and focus, and tells you what to start.

It talks to Claude **directly from the browser**, with no server in between. Anthropic
normally blocks browser-side calls to protect developers from shipping their own key to
every visitor; the request here opts in via the
`anthropic-dangerous-direct-browser-access` header, which is safe in this specific case
because the key is *yours*, in *your* browser, billed to *your* account.

### Setup

1. Create a key at
   [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys).
2. Open the **jAIme** tab and paste it in.
3. Decide whether to tick **Remember on this device** (see below).

### Where the key lives

By default the key is held **in memory only** and is forgotten when you reload — the same
rule the app applies to sync tokens. That means re-pasting it each session, so there's an
opt-in **Remember on this device** checkbox that stores it in `localStorage` instead.
That is a real trade-off, not a formality: anyone who can read that browser profile can
read the key. Leave it off on a shared machine.

### What it can and can't do

| It can | It can't |
| --- | --- |
| List and search tasks and projects | Delete anything |
| Create and edit tasks, complete or reopen them | Change your sync settings |
| Create projects | See anything outside this browser |
| Set your available time, focus, area and where you are | |

**Deletion is deliberately not offered.** It is the one action with no undo in the UI, and
a chat box is the wrong place for an irreversible action triggered by a sentence that
might have been misread. Ask jAIme to delete something and it will offer to complete it
instead.

**Recommendations come from the app, not the model.** jAIme is instructed to call the same
scoring engine the Focus tab uses rather than ranking tasks itself, so the two never
disagree and every suggestion still carries its point-by-point explanation. The model's
job is to interpret you and relay the answer, not to invent its own ordering.

Every action jAIme takes is printed in the transcript as it happens, so a conversation is
also an audit trail.

## Syncing with Microsoft To Do and Google Tasks

Sync is optional and off until you configure it. Both services talk to their APIs
directly from the browser, so there is still no server and no client secret. You can
connect either one, or both at once — each keeps its own independent link state.

The two accounts hold the two halves of your life:

| | Microsoft To Do | Google Tasks |
| --- | --- | --- |
| Carries | work **and** personal | personal only |
| New items default to | work | personal |

So a personal task exists in three places at once and stays in step everywhere, while a
work task never leaves Nextwise and Microsoft To Do.

### Microsoft To Do setup

You need a free Azure app registration. It takes about two minutes.

1. Go to [portal.azure.com](https://portal.azure.com) → **Microsoft Entra ID** →
   **App registrations** → **New registration**.
2. Name it anything (e.g. `Nextwise`) — the name is cosmetic, only the client ID matters.
3. Under *Supported account types* choose
   **Accounts in any organizational directory and personal Microsoft accounts**.
4. Under *Redirect URI*, select platform **Single-page application (SPA)** and enter the
   address you open the app at — `https://localhost:5173` for local development.
   It has to match exactly: same scheme, host and port, and no trailing slash.
   Note that `127.0.0.1` is rejected by Entra even over HTTPS — use `localhost`.
5. Click **Register**, then copy the **Application (client) ID** from the overview page.
6. In Nextwise, open the **Sync** tab, paste the ID under *Microsoft To Do*, click
   **Save**, then **Connect**.

No client secret is required, and no API permissions need to be pre-granted — the app
requests the single delegated scope `Tasks.ReadWrite` at sign-in.

### Google Tasks setup

Slightly longer, because Google asks you to describe the app before it will issue tokens.

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a
   project (or pick an existing one).
2. **APIs & Services** → **Library** → search *Google Tasks API* → **Enable**.
3. **APIs & Services** → **Google Auth Platform** → **Audience**. Set *User type* to
   **External**.
4. Still on **Audience**, find **Test users** → **Add users** → add your own Google
   address, and save. **Don't skip this** — see the troubleshooting note below.
5. Open the **Clients** tab → **Create client** → application type **Web application**.
6. Under **Authorized JavaScript origins** add the address you open the app at —
   `https://localhost:5173` for local development. **Leave "Authorized redirect URIs"
   empty**: the app uses the Google Identity Services token flow, which posts back into
   the page rather than redirecting.
7. Copy the **Client ID** (it ends in `.apps.googleusercontent.com`), paste it into the
   *Google Tasks* card on the **Sync** tab, click **Save**, then **Connect**.

> Older guides send you to **APIs & Services → OAuth consent screen**. Google folded
> that into **Google Auth Platform** (tabs: *Branding*, *Audience*, *Clients*), so the
> old menu item no longer exists.

#### "Error 403: access_denied" when connecting

> <your app> has not completed the Google verification process. The app is currently
> being tested, and can only be accessed by developer-approved testers.

This is step 4 above, and it's the most common stumbling block. A project starts in
**Testing**, where Google refuses tokens to *every* account that isn't on the test-user
list — including the account that owns the project. Add your address under
**Google Auth Platform → Audience → Test users**, then retry; changes take effect within
a minute or two. Sign out and back in if the old consent screen is cached.

Verification is only required if you want *other people* to use it. For personal use,
staying in Testing with yourself as the sole test user is the right setup — the only cost
is that consent lapses every 7 days, so you'll re-approve occasionally. (Publishing the
app instead would remove that, but the Tasks scope is *sensitive*, so an unverified
published app shows a scarier "Google hasn't verified this app" interstitial.)

Google's token flow issues no refresh token, so the browser holds a short-lived access
token in memory only. Nextwise silently renews it in the background while the tab is
open; if you close the tab you'll click **Connect** once more, which is usually a
one-click reauthorisation rather than a full consent screen.

### How the mapping works

| Nextwise          | Microsoft To Do          | Google Tasks              |
| -------------------- | ------------------------ | ------------------------- |
| Project              | Task list                | Task list                 |
| Task without project | Your default To Do list  | Your default list         |
| P1 / P2              | Importance **high**      | *notes footer*            |
| P3                   | Importance **normal**    | *notes footer*            |
| P4                   | Importance **low**       | *notes footer*            |
| Tags                 | Categories               | *notes footer*            |
| Due date             | Due date                 | Due date (date only)      |
| Done / open          | Completed / not started  | `completed` / `needsAction` |
| Notes                | Notes                    | Notes                     |
| Estimate, focus, area | *notes footer*          | *notes footer*            |
| Context, earliest start, waiting-on note | *notes footer* | *notes footer*  |
| Blocking task        | *stays local*            | *stays local*             |

Neither service has a field for **estimated duration**, **focus level** or any of the
availability fields, so those travel in a single compact footer line appended to the
task's notes:

```
[fb] est=45m focus=deep prio=P2 area=work ctx=laptop start=2026-03-01 wait=the%20quote
```

Only the keys a task actually uses are written, so a task with none of the newer fields
produces exactly the footer it always did and is never rewritten just to gain them.

It stays readable in both companies' apps, survives editing the note above it, and is
rewritten in place rather than duplicated. Priority and area ride along too so they
round-trip exactly instead of being flattened through To Do's coarser `importance`.

**One field is deliberately left behind.** *Blocked by* points at a specific task in this
browser's database. That id means nothing to another device pulling the same account, so
syncing it would either dangle or, worse, silently attach to an unrelated task. The
human-readable *waiting on* note syncs instead, and a blocking-task link stays local to
the device that drew it.

**The Google Tasks caveat:** the Google Tasks API has no priority, no tags and no
duration, so for Google those four values live *only* in the footer. They round-trip
through Nextwise perfectly, but Google's own apps will show them as plain text at the
bottom of the note, and editing that line by hand there will change them here. To Do
gets real `importance` and `categories` fields, so priority and tags stay first-class on
that side. Google also stores due dates as **dates without a time**, so a due time set
here is preserved locally but truncated on the Google copy.

### Behaviour worth knowing

- **Two-way.** Changes flow in both directions on every run. Microsoft delta queries and
  Google's `updatedMin` windows mean repeat syncs transfer almost nothing.
- **Conflicts** (edited in both places since the last sync) resolve to the most recent
  edit, and the run summary tells you how many happened.
- **Deletions** are pushed before anything is pulled, so a task you deleted here cannot
  be resurrected by the same run. Deleting a task that lives in both services removes it
  from both.
- **Existing lists are adopted by name**, so a list called *Hiring* links to a Nextwise
  project called *Hiring* instead of creating a duplicate. Unlinked tasks are
  adopted by title within a list the same way.
- **Tasks created remotely** arrive with sensible defaults (30m, medium focus) that you
  can refine here.
- **Each service carries one half of your life.** Work tasks go to Microsoft To Do only;
  personal tasks are mirrored to **both**. Google is a personal account, so work items
  simply never leave for it.
- **Each service has a default area** for things it has never seen: anything arriving from
  Microsoft To Do is filed as **work**, anything from Google Tasks as **personal**. It's
  only a fallback, and loses to both stronger signals: a task landing in a project takes
  that project's area, and a task this app wrote keeps the area recorded in its `[fb]`
  footer.
- **Re-filing a task moves it between services.** Switch a task from personal to work and
  the next sync *withdraws* it from Google — deletes the Google copy and forgets the link.
  Switch it back and Google gets it again. The same applies to projects: a project moved
  to work has its Google list removed, tasks and all. Nothing is ever deleted locally, and
  Microsoft is unaffected either way.
- **A personal task filed under a work project** has no list of its own in Google, since
  the project was never published there, so it lands in your Google inbox instead.
- **A list deleted remotely unlinks the project** rather than deleting your tasks.
- **Auto-sync** runs every 5 minutes while the tab is open, across every connected
  service, and is off by default.
- **Reset sync links** unlinks one service and re-matches on the next run. It never
  deletes tasks — it's the escape hatch if link state gets confused.

## Keeping the board in a GitHub repo

By default the browser profile is the only copy of your tasks, so clearing site data
loses them. The **GitHub backup** card at the top of the Sync tab fixes that: it keeps a
single JSON file in a private repository in step with this browser. It is a real sync,
not a one-way upload — open the app on your phone and it picks up what the laptop wrote,
and the other way round.

### Setting it up

1. Create a repository at [github.com/new](https://github.com/new). **Make it private** —
   the file holds every task you have.
2. Go to **Settings → Developer settings → Personal access tokens → Fine-grained tokens →
   Generate new token**.
3. Under **Repository access** choose *Only select repositories* and pick the one you just
   made.
4. Under **Permissions → Repository permissions**, set **Contents** to *Read and write*.
   Nothing else is needed.
5. Paste the repository (`you/nextwise-data`, or its address) and the token into the card,
   and press **Sync now**.

The file lands at `nextwise/board.json` on `main` unless you say otherwise. It is
pretty-printed, so the repository's commit history is a readable diary of what changed.

### What travels, and what doesn't

The file holds your **tasks and projects**, including the fields no external service has
a column for — checklist, `spentMin`, context, blocked-on notes, start dates.

It deliberately does **not** hold your Microsoft or Google sync links. Those record how
far *one particular browser* has reconciled with a provider; sharing them would let one
device's bookkeeping overwrite another's. A device that picks up a task from the file
adopts the provider's copy by title on its next sync instead of creating a duplicate.

Deletions travel too. A snapshot only lists what exists, so a deleted task would simply be
restored by whichever device still had it. Deleting a task therefore records a small
headstone (`uid` and a timestamp) that rides along in the file and is discarded after 90
days.

### When it saves

With **Save automatically** on, it saves a few seconds after you stop making changes, and
checks for other devices' changes when you return to the tab. **Sync now** ignores both.

If two devices edit the same task, the later edit wins. If one edits a task the other
deleted, the edit wins and the deletion is dropped, so the two stop fighting over it. If
two devices save at the same instant, the loser re-reads and merges rather than
overwriting.

### The token caveat

The token is stored in this site's `localStorage` so the board can save itself after a
reload — a token you must re-paste every time cannot do unattended saving, which is the
whole point. That means **anything else served from the same address could read it**. This
is why the setup above insists on a fine-grained token limited to one private repository
with only Contents access: that is the entire blast radius. Untick **Keep the token in
this browser** to hold it in memory for the session only, and **Forget token** removes it.

## Your data

Everything is stored locally in IndexedDB under `ProductivityDB`, and your current
context (time / focus / area) plus any running focus session in `localStorage`. Nothing
leaves the machine unless you turn on sync, in which case task data goes to your own
GitHub repository and/or your Microsoft and Google accounts — and the two local-only
fields a session writes, `spentMin` and `checklist`, go to the GitHub file but never to
Microsoft or Google.

**Export** downloads the same JSON document the GitHub backup writes, and **Import**
restores one inside a single transaction, replacing current contents. Files exported by
older builds still import.

Clearing site data for this origin will erase your tasks unless the GitHub backup is set
up.

## Tech

Vite · React 19 · TypeScript · Dexie (IndexedDB) · Tailwind CSS v4

- `src/types.ts` — data model
- `src/db.ts` — Dexie schema, migrations and first-run seed data
- `src/recommender.ts` — scoring and session planning (pure functions, no React)
- `src/availability.ts` — whether a task can be started at all: blocked, deferred,
  wrong place, and the cycle check behind the blocker picker. Shared by the recommender,
  the panels and the task row so they can never disagree about what "ready" means
- `src/session.ts` — the focus session: timer maths, persistence and checklist helpers.
  Pure and clock-injectable — every function takes `now`, so nothing has to wait on a
  real second to be tested
- `src/components/` — UI panels
- `src/sync/` — two-way sync, one algorithm shared by both services
  - `provider.ts` — the `SyncProvider` seam every service implements
  - `engine.ts` — the sync algorithm (delete → reconcile lists → pull → push)
  - `links.ts` — per-service link state (`syncLinks`), keyed by provider + record
  - `footer.ts` — the `[fb]` notes-footer codec both services share
  - `registry.ts` — the list of services; add a row here to support another one
  - `mapping.ts` / `graphClient.ts` / `auth.ts` / `msProvider.ts` — Microsoft To Do
  - `googleMapping.ts` / `googleClient.ts` / `googleAuth.ts` / `googleProvider.ts` — Google Tasks
  - `fakeGraph.ts` / `fakeGoogle.ts` — in-memory servers used to test sync for real
