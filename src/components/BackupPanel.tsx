import { useState } from "react";
import { Button, Card, Field, SectionTitle, TextInput } from "../ui";
import type { UseBackup } from "../backup/useBackup";
import { DEFAULT_PATH, looksLikeToken, parseRepoInput } from "../backup/config";

function relative(ts?: number): string {
  if (!ts) return "never";
  const secs = Math.round((Date.now() - ts) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return new Date(ts).toLocaleString();
}

const STEPS = [
  "Open github.com/new and create a repository. Make it Private — the file holds every task you have.",
  "Go to Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.",
  'Under "Repository access" choose "Only select repositories" and pick the one you just made.',
  'Under "Permissions" → Repository permissions, set Contents to "Read and write". Nothing else is needed.',
  "Generate the token, copy it, and paste it above. It is shown only once.",
];

export function BackupPanel({ backup }: { backup: UseBackup }) {
  const [repoDraft, setRepoDraft] = useState(
    backup.repo.owner ? `${backup.repo.owner}/${backup.repo.repo}` : "",
  );
  const [pathDraft, setPathDraft] = useState(backup.repo.path || DEFAULT_PATH);
  const [branchDraft, setBranchDraft] = useState(backup.repo.branch || "main");
  const [tokenDraft, setTokenDraft] = useState("");
  const [remember, setRemember] = useState(backup.remember);
  const [showSetup, setShowSetup] = useState(!backup.configured);
  const [confirmForget, setConfirmForget] = useState(false);

  const parsed = parseRepoInput(repoDraft);
  const repoChanged =
    Boolean(parsed) &&
    (parsed!.owner !== backup.repo.owner ||
      parsed!.repo !== backup.repo.repo ||
      pathDraft.trim() !== backup.repo.path ||
      branchDraft.trim() !== backup.repo.branch);
  const repoInvalid = repoDraft.trim().length > 0 && !parsed;
  const tokenSuspect =
    tokenDraft.trim().length > 0 && !looksLikeToken(tokenDraft);

  const ready = backup.configured && backup.hasToken;

  return (
    <div data-backup-panel>
      <Card className="p-5">
        <div className="flex items-start justify-between gap-3">
          <SectionTitle hint="Keeps one JSON file in a private repository in step with this browser, so the board survives a cleared cache and follows you between devices.">
            GitHub backup
          </SectionTitle>
          <span
            className={`mt-1 inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs ${
              ready ? "bg-emerald-500/15 text-good" : "bg-raise-1 text-mist-500"
            }`}
          >
            <span
              data-backup-dot={ready ? "ready" : "not-ready"}
              className={`h-1.5 w-1.5 rounded-full ${ready ? "bg-emerald-400" : "bg-mist-500"}`}
            />
            {ready ? "Saving" : "Not set up"}
          </span>
        </div>

        <div className="mt-4 space-y-4">
          <Field label="Repository">
            <TextInput
              value={repoDraft}
              onChange={(e) => setRepoDraft(e.target.value)}
              placeholder="you/nextwise-data"
              spellCheck={false}
              data-backup-repo
            />
            {repoInvalid && (
              <p className="mt-1 text-xs text-warn">
                Use <code>owner/repository</code>, or paste the repository's
                address.
              </p>
            )}
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="File">
              <TextInput
                value={pathDraft}
                onChange={(e) => setPathDraft(e.target.value)}
                placeholder={DEFAULT_PATH}
                spellCheck={false}
              />
            </Field>
            <Field label="Branch">
              <TextInput
                value={branchDraft}
                onChange={(e) => setBranchDraft(e.target.value)}
                placeholder="main"
                spellCheck={false}
              />
            </Field>
          </div>

          <Button
            variant={repoChanged ? "primary" : "ghost"}
            disabled={!repoChanged}
            onClick={() =>
              backup.saveRepo({
                owner: parsed!.owner,
                repo: parsed!.repo,
                branch: branchDraft.trim() || "main",
                path: pathDraft.trim() || DEFAULT_PATH,
              })
            }
          >
            Save repository
          </Button>

          <Field
            label={backup.hasToken ? "Access token — saved" : "Access token"}
          >
            <div className="flex gap-2">
              <TextInput
                type="password"
                value={tokenDraft}
                onChange={(e) => setTokenDraft(e.target.value)}
                className="flex-1"
                placeholder={backup.hasToken ? "••••••••••••" : "github_pat_…"}
                spellCheck={false}
                autoComplete="off"
                data-backup-token
              />
              <Button
                variant={tokenDraft.trim() ? "primary" : "ghost"}
                disabled={!tokenDraft.trim()}
                onClick={() => {
                  backup.saveToken(tokenDraft, remember);
                  setTokenDraft("");
                }}
              >
                Save
              </Button>
            </div>
            {tokenSuspect && (
              <p className="mt-1 text-xs text-warn">
                GitHub tokens start with <code>github_pat_</code> or{" "}
                <code>ghp_</code>. Check the paste.
              </p>
            )}
          </Field>

          <label className="flex cursor-pointer items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => {
                setRemember(e.target.checked);
                if (backup.hasToken)
                  backup.saveToken(tokenDraft, e.target.checked);
              }}
              className="mt-0.5"
            />
            <span className="text-mist-400">
              Keep the token in this browser.{" "}
              <span className="text-mist-500">
                Needed for the board to save itself after a reload. It is stored
                in this site's local storage, so anything else served from this
                address could read it — which is why the token should reach
                exactly one private repository and nothing else.
              </span>
            </span>
          </label>

          <button
            onClick={() => setShowSetup((s) => !s)}
            className="text-xs font-medium text-work hover:text-fg"
          >
            {showSetup ? "Hide setup steps" : "Where do I get these?"}
          </button>

          {showSetup && (
            <div className="rounded-lg border border-line bg-ink-900/40 p-3">
              <ol className="list-decimal space-y-1.5 pr-1 pl-5 text-sm text-mist-300">
                {STEPS.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </div>
          )}

          <p className="text-xs leading-relaxed text-mist-500">
            The file holds your tasks and projects. Connections to Microsoft and
            Google stay in each browser, because they record how far that one
            browser has got — a device picks up tasks that arrive this way and
            matches them to its own links on the next sync.
          </p>

          <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
            <Button
              variant="primary"
              onClick={() => void backup.syncNow()}
              disabled={!ready || backup.running}
            >
              {backup.running ? "Saving…" : "Sync now"}
            </Button>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={backup.auto}
                onChange={(e) => backup.setAuto(e.target.checked)}
              />
              <span className="text-mist-400">Save automatically</span>
            </label>
            <span className="ml-auto text-xs text-mist-500">
              {relative(backup.lastSyncAt)}
            </span>
          </div>

          {backup.error && (
            <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-danger">
              {backup.error}
            </p>
          )}

          {backup.lastResult && !backup.error && (
            <div className="rounded-lg border border-line bg-ink-900/40 px-3 py-2 text-sm text-mist-200">
              {backup.lastResult.tasks} task
              {backup.lastResult.tasks === 1 ? "" : "s"} and{" "}
              {backup.lastResult.projects} project
              {backup.lastResult.projects === 1 ? "" : "s"} in the file.
              {backup.lastResult.pulled.created +
                backup.lastResult.pulled.updated >
                0 && (
                <span className="ml-1 text-mist-400">
                  {backup.lastResult.pulled.created} added and{" "}
                  {backup.lastResult.pulled.updated} updated here.
                </span>
              )}
              {backup.lastResult.pulled.deleted > 0 && (
                <span className="ml-1 text-mist-400">
                  {backup.lastResult.pulled.deleted} removed here.
                </span>
              )}
            </div>
          )}

          {backup.hasToken && (
            <div className="border-t border-line pt-4">
              {confirmForget ? (
                <div className="space-y-2">
                  <p className="text-xs text-mist-400">
                    Removes the token from this browser. The file and your tasks
                    are untouched, and saving stops until a token is pasted
                    again.
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="danger"
                      onClick={() => {
                        backup.clearToken();
                        setConfirmForget(false);
                      }}
                    >
                      Forget token
                    </Button>
                    <Button onClick={() => setConfirmForget(false)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmForget(true)}
                  className="text-xs font-medium text-mist-500 hover:text-mist-300"
                >
                  Forget token…
                </button>
              )}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
