-- F-027-w — the figure the collector raises a ceiling to before it exits
-- (ADR-0078, ADR-0072).
--
-- The collector is the only thing that reads a panel's counters, so while it
-- is down nothing measures, nothing buys and no ceiling rises. A weekly deploy
-- is therefore a few minutes in which every metered user runs into a ceiling
-- that was sized for two minutes of their own traffic — with money in their
-- wallet, and nothing wrong anywhere. Removing the ceiling instead would serve
-- traffic nobody bought, which is the hole ADR-0072 exists to close.
--
-- So the ceiling is **extended, not removed**, to what the user's money still
-- backs: their share of a bag of `purchasedBytes` plus what their wallet would
-- buy at the Grant's locked rate.
--
-- WHY A COLUMN AND NOT A CALL
--
-- The wallet is `billing.*` and only `billing-service` prices a byte
-- (ADR-0073); the write to the panel is only `network-service`'s, because the
-- driver is there. Nothing carries a figure between the two processes today.
-- A column is the channel that does not fail at the moment it is needed: an
-- HTTP call at SIGTERM would need `billing-service` to be up during exactly
-- the deploy that is taking both services down, and a collector reading
-- `billing.wallet` itself would put the whole-cent rate arithmetic in two
-- languages. The allocator refreshes this in the same transaction that writes
-- `allocatedCeilingBytes`, so it is never more than one pass stale — and
-- staleness here is always in the safe direction, because it is money the user
-- had a minute ago. Decided with the user 2026-09-22; ADR-0078.
--
-- `>= "allocatedCeilingBytes"` is a CHECK rather than a comment: the whole
-- meaning of this number is that it is the larger one, and a row where it is
-- not would have a shutdown quietly *lowering* a ceiling on the way out.
--
-- Additive and nullable, over a table no service has ever written
-- (`network.config`, `source: []`). Rollback: drop the constraint, then the
-- column.

ALTER TABLE "network"."config"
    ADD COLUMN "walletBackedCeilingBytes" BIGINT;

ALTER TABLE "network"."config"
    ADD CONSTRAINT "config_wallet_backed_ceiling_extends" CHECK (
        "walletBackedCeilingBytes" IS NULL
        OR ("walletBackedCeilingBytes" >= 0
            AND ("allocatedCeilingBytes" IS NULL
                 OR "walletBackedCeilingBytes" >= "allocatedCeilingBytes")));
