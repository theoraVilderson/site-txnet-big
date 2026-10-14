import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SnapshotResponse } from "./client";

/** A cached file's name for an empty scope ("every scope"). */
const ALL_SCOPES_FILE = "all";
const MINUTE_MS = 60_000;

/** Every snapshot read back for a scope, and how old the oldest one is. */
export interface SavedSnapshots {
  snapshots: SnapshotResponse[];
  ageMin: number;
}

/**
 * The snapshots of one scope on disk, `<scope>.<lang>.json` under `dir`
 * (hosting H17). A save is a temp file renamed over the old one, so a reader —
 * the next boot — never sees half a file. Neither direction throws: a cache
 * that cannot be written or read is a warning, never a reason to stop serving.
 */
export function snapshotDisk(dir: string, scope: string, log: Pick<Console, "warn">) {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    log.warn(`[locale] cannot create cache dir ${dir}: ${String(err)}`);
  }
  let seq = 0;
  const prefix = `${scope || ALL_SCOPES_FILE}.`;

  return {
    save(snap: SnapshotResponse): void {
      const file = join(dir, `${prefix}${snap.lang}.json`);
      const tmp = `${file}.${process.pid}.${++seq}.tmp`;
      writeFile(tmp, JSON.stringify(snap))
        .then(() => rename(tmp, file))
        .catch((err) => log.warn(`[locale] could not cache ${snap.lang}: ${String(err)}`));
    },

    /** `null` when nothing for this scope could be read. */
    load(): SavedSnapshots | null {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch (err) {
        log.warn(`[locale] cannot read cache dir ${dir}: ${String(err)}`);
        return null;
      }
      const snapshots: SnapshotResponse[] = [];
      let oldest = Number.POSITIVE_INFINITY;
      for (const name of names.filter((n) => n.startsWith(prefix) && n.endsWith(".json")).sort()) {
        const path = join(dir, name);
        try {
          const snapshot = JSON.parse(readFileSync(path, "utf8")) as SnapshotResponse;
          if (typeof snapshot?.lang !== "string" || typeof snapshot.namespaces !== "object") throw new Error("not a snapshot");
          snapshots.push(snapshot);
          oldest = Math.min(oldest, statSync(path).mtimeMs);
        } catch (err) {
          log.warn(`[locale] skipped cached ${name}: ${String(err)}`);
        }
      }
      return snapshots.length === 0 ? null : { snapshots, ageMin: Math.round((Date.now() - oldest) / MINUTE_MS) };
    },
  };
}
