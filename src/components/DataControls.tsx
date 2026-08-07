import { useRef } from "react";
import { db, newUid } from "../db";
import type { Project, Task } from "../types";
import { Button } from "../ui";
import { parseSnapshot, SnapshotFormatError } from "../backup/snapshot";
import { applySnapshot, backfillUids, readLocal } from "../backup/store";

/** The shape older builds wrote, kept readable so those files still import. */
interface LegacyBackup {
  version: 1;
  projects: Project[];
  tasks: Task[];
}

/**
 * A file on disk, in the same format as the copy in the repository.
 *
 * Downloading and syncing produce the same document on purpose: a file only one
 * code path can read is a backup nobody can be sure of. The export therefore
 * goes through the snapshot builder rather than dumping the tables, which is
 * also what makes deletions travel with it.
 */
export function DataControls({
  tasks,
  projects,
}: {
  tasks: Task[];
  projects: Project[];
}) {
  const fileRef = useRef<HTMLInputElement>(null);

  const exportData = async () => {
    const snapshot = await readLocal(Date.now());
    const blob = new Blob([`${JSON.stringify(snapshot, null, 2)}\n`], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `nextwise-board-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importLegacy = async (parsed: LegacyBackup) => {
    await db.transaction(
      "rw",
      db.tasks,
      db.projects,
      db.graveyard,
      async () => {
        await db.tasks.clear();
        await db.projects.clear();
        await db.graveyard.clear();
        // Files written before portable ids existed carry none, and a record
        // without one cannot be matched across devices afterwards.
        await db.projects.bulkAdd(
          parsed.projects.map((p) => ({ ...p, uid: p.uid || newUid() })),
        );
        await db.tasks.bulkAdd(
          parsed.tasks.map((t) => ({ ...t, uid: t.uid || newUid() })),
        );
      },
    );
    await backfillUids();
  };

  const importData = async (file: File) => {
    const text = await file.text();
    try {
      let counts: { tasks: number; projects: number };
      let apply: () => Promise<void>;

      try {
        const snapshot = parseSnapshot(text);
        counts = {
          tasks: snapshot.tasks.length,
          projects: snapshot.projects.length,
        };
        apply = async () => {
          // Cleared first so this really is a restore: applying on top would
          // merge the file into whatever is here, which is what Sync is for.
          await db.transaction(
            "rw",
            db.tasks,
            db.projects,
            db.graveyard,
            async () => {
              await db.tasks.clear();
              await db.projects.clear();
              await db.graveyard.clear();
            },
          );
          await applySnapshot(snapshot);
        };
      } catch (err) {
        if (!(err instanceof SnapshotFormatError)) throw err;
        const legacy = JSON.parse(text) as Partial<LegacyBackup>;
        if (!Array.isArray(legacy.tasks) || !Array.isArray(legacy.projects)) {
          throw new Error("Not a Nextwise board file");
        }
        counts = {
          tasks: legacy.tasks.length,
          projects: legacy.projects.length,
        };
        apply = () => importLegacy(legacy as LegacyBackup);
      }

      const ok = window.confirm(
        `Import ${counts.tasks} tasks and ${counts.projects} projects? This replaces everything currently stored.`,
      );
      if (!ok) return;
      await apply();
    } catch (err) {
      window.alert(`Could not import that file: ${(err as Error).message}`);
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="flex items-center gap-2">
      <input
        ref={fileRef}
        type="file"
        accept="application/json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void importData(file);
        }}
      />
      <Button
        variant="subtle"
        onClick={() => void exportData()}
        title={`Download all ${tasks.length} tasks and ${projects.length} projects as JSON`}
      >
        Export
      </Button>
      <Button
        variant="subtle"
        onClick={() => fileRef.current?.click()}
        title="Restore from JSON"
      >
        Import
      </Button>
    </div>
  );
}
