# ADR-0120 — Object storage upkeep: a reseller quota, a guide file sweep, a disk alert and a restic backup

- Status: accepted (user, 2026-10-04)
- Feature: F-414 (row F-414-m)

## Context

Guide videos (F-414-i, ≤ 50 MiB each) made the object volume the fastest
growing thing a reseller controls. Nothing bounded it, nothing removed a file
an editor uploaded and never used, nothing warned before the disk filled, and
the volume had no backup. The server is shared with the user's live site and
bot, and its disk was 72% full on 2026-10-04. The user was asked four questions
the same day and chose the recommended answer to each:

- the quota counts the files a reseller's **admins** upload, set where the
  other reseller limits are;
- an unused guide file is removed **7 days after upload**;
- the backup is **restic, to a destination set by configuration**.

## Decision

1. **`storage_mib_max`, a reseller guard** (ADR-0106/0107): default 1024 MiB,
   at most 1 048 576. Its usage is the size of the reseller's stored objects
   under `branding/` and `guides/` (`STORAGE_QUOTA_PREFIXES`), rounded up to
   whole MiB. Support attachments, which its users upload, are not counted:
   a full quota must never stop a customer from reaching support. The
   platform's own tenant is exempt, as for every limit.
2. **Checked before each upload** (`StorageQuota.assertRoom`): the stored
   bytes, minus the file being replaced at the same key, plus the new file,
   must fit. A refusal is `reseller_limit_reached` with the key, the limit and
   what is used, as the other guards. The check takes an advisory lock but the
   write happens after it, so two uploads at the same moment can pass the
   limit by one file. That is accepted for a ceiling counted in MiB.
3. **Unused guide files are swept nightly** by worker-service's
   `guide_file_sweep` (`15 4 * * *`). It calls tenant-service's
   `POST /api/internal/guides/file-sweep`, which owns the rule (ADR-0027, as
   support retention). A file under any owner's `guides/` that is older than
   7 days and named by no published text and no draft of **any** tenant is
   deleted, row first and then bytes. All tenants are read because a
   reseller's override names the platform's files (ADR-0117 point 2). At most
   500 files are deleted per run, and a run is safe to repeat.
4. **Disk alerts in Prometheus** (`storage.rules.yml`), over node-exporter's
   filesystems: under 15% free is a warning, under 5% is critical, and a disk
   that will fill within 24 hours at its 6-hour trend is a warning. They read
   the host's filesystem, which holds the object volume on the `local` driver.
5. **A nightly restic backup of the object volume** (`object-backup`, an
   Alpine image with Alpine's restic package; the mirror has no restic image).
   The container mounts the volume read-only. `RESTIC_REPOSITORY` and the
   password file are configuration: a local directory in dev, and in
   production a target off this server (S3, SFTP or a REST server). Each run
   backs up, then keeps 7 daily, 4 weekly and 6 monthly snapshots, and
   writes `txnet_object_backup_*` to node-exporter's textfile directory.
   `ObjectBackupStale` fires when no backup has succeeded for 36 hours, or
   when none has ever been recorded.

## Consequences

- A backup on the same disk as the volume protects against deleting a file,
  not against losing the disk. Production is not covered until an off-server
  `RESTIC_REPOSITORY` is set, and the stale alert says so until it is.
- Losing the restic password makes every snapshot unreadable, like
  `vault-kek` (ADR-0026), so it is kept with the other secrets.
- An S3 driver later replaces points 3–5 with the bucket's own lifecycle and
  versioning; points 1–2 stay.

## Amendment, 2026-10-30 — the files' backup is a locked copy in the bucket, not restic (F-018-m2-c)

User, 2026-10-30, with the move to S3: a nightly `mc mirror` of the files into
the backup bucket (`txnet-backups`, the bundle's, B7), each copy's compliance
lock renewed for 7 days, and versioning on `txnet-main-data` with noncurrent
versions kept 30 days. Restic and its password are gone: the copy left the
server from its first run, which restic's repository on the host never did,
and whoever holds the Arvan key can hide a copy but not erase it inside the
lock. Points 1–2 stand; the "S3 driver later" consequence above is this.
