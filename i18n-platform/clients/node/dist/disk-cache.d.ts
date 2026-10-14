import type { SnapshotResponse } from "./client";
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
export declare function snapshotDisk(dir: string, scope: string, log: Pick<Console, "warn">): {
    save(snap: SnapshotResponse): void;
    /** `null` when nothing for this scope could be read. */
    load(): SavedSnapshots | null;
};
