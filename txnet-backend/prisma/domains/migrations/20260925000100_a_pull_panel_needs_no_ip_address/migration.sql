-- F-027-br — a pull panel needs no IP address.
--
-- The only reader of `ipAddress` is the RADIUS allowlist, and it reads push
-- panels only: a NAS is known by the address its packets come from. A pull
-- panel is reached at `apiBaseUrl`, so asking its owner for an IP nothing reads
-- only got a guess typed in.
--
-- Nullable for pull, still required for push by the CHECK. Existing rows keep
-- their value: no backfill. Rollback: drop the constraint, set NOT NULL (every
-- row written before this has an address).

ALTER TABLE "network"."panel" ALTER COLUMN "ipAddress" DROP NOT NULL;

ALTER TABLE "network"."panel"
    ADD CONSTRAINT "panel_push_has_ip_address"
    CHECK ("transport" <> 'push' OR "ipAddress" IS NOT NULL);
