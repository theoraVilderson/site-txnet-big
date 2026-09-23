-- F-027-z — a config that was deleted or moved away is `retired`, and a
-- retired config is never on a panel again.
--
-- Every action on a config writes desired state (ADR-0075), and two of them —
-- delete, and the old side of a move — write `desiredRemote = absent`, the same
-- value the purge writes (F-027-y). The purge is temporary: a top-up restores
-- it. A delete is not, and `desiredRemote` alone cannot tell the two apart, so
-- the top-up that revives a Grant would rebuild a client the user deleted and
-- the old seat of every config that moved. `status = retired` is the
-- difference, and the revive restores only `status = active` configs — which
-- also stops it re-enabling one an admin disabled.
--
-- A move is a new row on the target panel, never a rewrite of `panelId`: the
-- counter cursor, the traffic history and `(panelId, remoteId)` are all one
-- panel's, and a row that changed panel would compare the new panel's counter
-- against the old one's cursor.
--
-- The CHECK compares as text: the new enum value cannot be used as a literal
-- in the transaction that adds it (same shape as 20260915000100).
--
-- Additive; `network.config` has never held a row. Rollback: drop the
-- constraint; the enum value stays (Postgres cannot drop one) and nothing
-- writes it.

ALTER TYPE "network"."ConfigStatus" ADD VALUE IF NOT EXISTS 'retired';

ALTER TABLE "network"."config"
    ADD CONSTRAINT "config_retired_is_absent" CHECK (
        "status"::text <> 'retired' OR "desiredRemote" = 'absent');
