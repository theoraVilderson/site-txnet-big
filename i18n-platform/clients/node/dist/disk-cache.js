"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.snapshotDisk = snapshotDisk;
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
/** A cached file's name for an empty scope ("every scope"). */
const ALL_SCOPES_FILE = "all";
const MINUTE_MS = 60_000;
/**
 * The snapshots of one scope on disk, `<scope>.<lang>.json` under `dir`
 * (hosting H17). A save is a temp file renamed over the old one, so a reader —
 * the next boot — never sees half a file. Neither direction throws: a cache
 * that cannot be written or read is a warning, never a reason to stop serving.
 */
function snapshotDisk(dir, scope, log) {
    try {
        (0, node_fs_1.mkdirSync)(dir, { recursive: true });
    }
    catch (err) {
        log.warn(`[locale] cannot create cache dir ${dir}: ${String(err)}`);
    }
    let seq = 0;
    const prefix = `${scope || ALL_SCOPES_FILE}.`;
    return {
        save(snap) {
            const file = (0, node_path_1.join)(dir, `${prefix}${snap.lang}.json`);
            const tmp = `${file}.${process.pid}.${++seq}.tmp`;
            (0, promises_1.writeFile)(tmp, JSON.stringify(snap))
                .then(() => (0, promises_1.rename)(tmp, file))
                .catch((err) => log.warn(`[locale] could not cache ${snap.lang}: ${String(err)}`));
        },
        /** `null` when nothing for this scope could be read. */
        load() {
            let names;
            try {
                names = (0, node_fs_1.readdirSync)(dir);
            }
            catch (err) {
                log.warn(`[locale] cannot read cache dir ${dir}: ${String(err)}`);
                return null;
            }
            const snapshots = [];
            let oldest = Number.POSITIVE_INFINITY;
            for (const name of names.filter((n) => n.startsWith(prefix) && n.endsWith(".json")).sort()) {
                const path = (0, node_path_1.join)(dir, name);
                try {
                    const snapshot = JSON.parse((0, node_fs_1.readFileSync)(path, "utf8"));
                    if (typeof snapshot?.lang !== "string" || typeof snapshot.namespaces !== "object")
                        throw new Error("not a snapshot");
                    snapshots.push(snapshot);
                    oldest = Math.min(oldest, (0, node_fs_1.statSync)(path).mtimeMs);
                }
                catch (err) {
                    log.warn(`[locale] skipped cached ${name}: ${String(err)}`);
                }
            }
            return snapshots.length === 0 ? null : { snapshots, ageMin: Math.round((Date.now() - oldest) / MINUTE_MS) };
        },
    };
}
