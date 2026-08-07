import { useState } from "react";
import { Button, Card, Field, SectionTitle, TextInput } from "../ui";
import type { ProviderSync, UseSync } from "../sync/useSync";
import type { SyncCounts } from "../sync/engine";
import type { ProviderId } from "../types";
import { DEFAULT_DOMAIN, PUSH_DOMAINS } from "../sync/provider";
import { appUrl } from "../sync/auth";
import { BackupPanel } from "./BackupPanel";
import type { UseBackup } from "../backup/useBackup";

function relative(ts?: number): string {
  if (!ts) return "never";
  const secs = Math.round((Date.now() - ts) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return new Date(ts).toLocaleString();
}

function Counts({ label, counts }: { label: string; counts: SyncCounts }) {
  const total = counts.created + counts.updated + counts.deleted;
  return (
    <div className="rounded-lg border border-line bg-ink-900/40 px-3 py-2">
      <div className="text-xs font-medium tracking-wide text-mist-400 uppercase">
        {label}
      </div>
      {total === 0 ? (
        <div className="mt-1 text-sm text-mist-500">nothing</div>
      ) : (
        <div className="mt-1 text-sm text-mist-200">
          {counts.created > 0 && (
            <span className="mr-3">{counts.created} added</span>
          )}
          {counts.updated > 0 && (
            <span className="mr-3">{counts.updated} updated</span>
          )}
          {counts.deleted > 0 && <span>{counts.deleted} removed</span>}
        </div>
      )}
    </div>
  );
}

const SETUP: Record<
  ProviderId,
  { steps: string[]; uriLabel: string; uri: () => string }
> = {
  mstodo: {
    uriLabel: "Redirect URI — must match exactly",
    // Entra redirects back to a specific page, so a subfolder build has to
    // register the subfolder.
    uri: appUrl,
    steps: [
      "Open entra.microsoft.com → App registrations → New registration.",
      'Give it any name and allow "Accounts in any organizational directory and personal Microsoft accounts".',
      'Under Redirect URI pick platform "Single-page application (SPA)" and paste the address below.',
      'Register, then copy the "Application (client) ID" from the overview page into the field above.',
      "No client secret is needed — this app signs in with PKCE straight from the browser.",
    ],
  },
  gtasks: {
    uriLabel: "Authorized JavaScript origin — must match exactly",
    // Google validates the calling origin, and an origin cannot carry a path,
    // so this stays the bare origin even for a subfolder build.
    uri: () => window.location.origin,
    steps: [
      'Open console.cloud.google.com, create a project, then enable the "Google Tasks API" for it.',
      "Go to APIs & Services → Google Auth Platform → Audience and set User type to External.",
      'Still on Audience, under "Test users" click Add users and add your own Google address. Skipping this is what causes "Error 403: access_denied" at sign-in.',
      "Open the Clients tab → Create client → application type Web application.",
      'Paste the address below under "Authorized JavaScript origins". Leave redirect URIs empty.',
      "Copy the generated Client ID into the field above. The client secret is not used.",
    ],
  },
};

/** Google's short-lived tokens mean the connection lapses; say so plainly. */
const NOTES: Partial<Record<ProviderId, string>> = {
  gtasks:
    "Google Tasks has no field for priority, duration, focus or tags, so those ride along in the task notes as a single [fb] line. Edit the words above it freely.",
};

/** Neither half of the split is discoverable from the UI, so spell it out. */
function areaNote(id: ProviderId): string {
  const carries = PUSH_DOMAINS[id];
  const scope =
    carries.length > 1
      ? "Carries both your work and personal tasks."
      : `Carries your ${carries[0]} tasks only — the rest never leave the other service.`;
  return `${scope} Tasks arriving from here are filed as ${DEFAULT_DOMAIN[id]}, unless they belong to a project that says otherwise. Re-filing a task moves it between services on the next sync.`;
}

function ProviderCard({ p }: { p: ProviderSync }) {
  const [draftId, setDraftId] = useState(p.clientId);
  const [showSetup, setShowSetup] = useState(!p.clientId);
  const [confirmReset, setConfirmReset] = useState(false);

  const connected = Boolean(p.account);
  const idChanged = draftId.trim() !== p.clientId;
  const setup = SETUP[p.id];
  const note = NOTES[p.id];

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <SectionTitle
          hint={`Two-way sync. Your data never leaves your browser and ${p.label}.`}
        >
          {p.label}
        </SectionTitle>
        <span
          className={`mt-1 inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs ${
            connected
              ? "bg-emerald-500/15 text-good"
              : "bg-raise-1 text-mist-500"
          }`}
        >
          <span
            data-status-dot={connected ? "connected" : "disconnected"}
            className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-emerald-400" : "bg-mist-500"}`}
          />
          {connected ? "Connected" : "Not connected"}
        </span>
      </div>

      <div className="mt-4 space-y-4">
        <Field label={p.clientIdLabel}>
          <div className="flex gap-2">
            <TextInput
              value={draftId}
              onChange={(e) => setDraftId(e.target.value)}
              className="flex-1"
              placeholder={
                p.id === "gtasks"
                  ? "….apps.googleusercontent.com"
                  : "00000000-0000-0000-0000-000000000000"
              }
              spellCheck={false}
            />
            <Button
              variant={idChanged ? "primary" : "ghost"}
              disabled={!idChanged}
              onClick={() => p.saveClientId(draftId)}
            >
              Save
            </Button>
          </div>
        </Field>

        <button
          onClick={() => setShowSetup((s) => !s)}
          className="text-xs font-medium text-work hover:text-fg"
        >
          {showSetup ? "Hide setup steps" : "Where do I get this?"}
        </button>

        {showSetup && (
          <div className="space-y-3 rounded-lg border border-line bg-ink-900/40 p-3">
            <ol className="list-decimal space-y-1.5 pr-1 pl-5 text-sm text-mist-300">
              {setup.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <div>
              <div className="text-xs font-medium tracking-wide text-mist-400 uppercase">
                {setup.uriLabel}
              </div>
              <code className="mt-1 block rounded border border-line bg-ink-900/80 px-2 py-1.5 text-sm break-all text-work">
                {setup.uri()}
              </code>
              {window.location.protocol !== "https:" &&
                window.location.hostname !== "localhost" && (
                  <p className="mt-1.5 text-xs text-warn">
                    Both services require HTTPS (the one exception being plain{" "}
                    <code>http://localhost</code> for Microsoft). Serve this
                    page over HTTPS before registering it.
                  </p>
                )}
            </div>
          </div>
        )}

        {note && (
          <p className="text-xs leading-relaxed text-mist-500">{note}</p>
        )}
        <p className="text-xs leading-relaxed text-mist-500">
          {areaNote(p.id)}
        </p>

        <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
          {connected ? (
            <>
              <Button
                variant="primary"
                onClick={() => void p.syncNow()}
                disabled={p.syncing || p.busy}
              >
                {p.syncing ? "Syncing…" : "Sync now"}
              </Button>
              <Button onClick={() => void p.disconnect()} disabled={p.busy}>
                Disconnect
              </Button>
              <span className="ml-auto text-xs text-mist-500">
                {relative(p.lastSyncAt)}
              </span>
            </>
          ) : (
            <Button
              variant="primary"
              onClick={() => void p.connect()}
              disabled={p.busy || !p.clientId}
            >
              {p.busy ? "Connecting…" : `Connect ${p.label}`}
            </Button>
          )}
        </div>

        {p.error && (
          <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-danger">
            {p.error}
          </p>
        )}

        {p.lastResult && (
          <div className="space-y-2">
            <Counts label={`From ${p.label}`} counts={p.lastResult.pulled} />
            <Counts label={`To ${p.label}`} counts={p.lastResult.pushed} />
            {p.lastResult.conflicts > 0 && (
              <p className="text-xs text-warn">
                {p.lastResult.conflicts} edited in both places — the most recent
                change won.
              </p>
            )}
          </div>
        )}

        <div className="border-t border-line pt-4">
          {confirmReset ? (
            <div className="space-y-2">
              <p className="text-xs text-mist-400">
                Unlinks every task from {p.label} and re-matches on the next
                sync. No tasks are deleted, and your other connections are
                untouched.
              </p>
              <div className="flex gap-2">
                <Button
                  variant="danger"
                  onClick={() => {
                    void p.forgetLinks();
                    setConfirmReset(false);
                  }}
                >
                  Reset links
                </Button>
                <Button onClick={() => setConfirmReset(false)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setConfirmReset(true)}
              className="text-xs font-medium text-mist-500 hover:text-mist-300"
            >
              Reset sync links…
            </button>
          )}
        </div>
      </div>
    </Card>
  );
}

export function SyncPanel({
  sync,
  backup,
}: {
  sync: UseSync;
  backup: UseBackup;
}) {
  return (
    <div className="space-y-4">
      <BackupPanel backup={backup} />

      <Card className="p-5">
        <SectionTitle hint="Connect either service, or both — each keeps its own links, so the same task can live in both places.">
          Status
        </SectionTitle>

        <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="text-sm">
            <span className="text-mist-400">Last synced </span>
            <span className="text-mist-200">{relative(sync.lastSyncAt)}</span>
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={sync.autoSync}
              onChange={(e) => sync.setAutoSync(e.target.checked)}
            />
            <span className="text-mist-400">Auto-sync every 5 minutes</span>
          </label>

          <Button
            variant="primary"
            className="ml-auto"
            onClick={() => void sync.syncAll()}
            disabled={sync.connectedCount === 0 || sync.syncing}
          >
            {sync.syncing ? "Syncing…" : "Sync all"}
          </Button>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {sync.providers.map((p) => (
          <ProviderCard key={p.id} p={p} />
        ))}
      </div>
    </div>
  );
}
