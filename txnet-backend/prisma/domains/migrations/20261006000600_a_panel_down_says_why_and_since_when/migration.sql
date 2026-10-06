-- F-027-ej — a panel that is not healthy says why, and since when (ADR-0122).
--
-- `panelState` alone could not tell "down because the DNS record changed"
-- from "down because the login changed", and nothing told a fresh `healthy`
-- from one written three days ago by a collector that has since died (the
-- dev incident of 2026-10-06). The cause is a closed set the page translates;
-- `panelStateSince` is when the trouble started; `panelCheckedAt` is the last
-- turn the collector judged the panel on.
--
-- Additive and nullable: no backfill, every existing row is a healthy panel
-- with no cause. Rollback: drop the constraint, the three columns and the type.

CREATE TYPE "network"."PanelFaultCause" AS ENUM ('dns_failed', 'connection_refused', 'unreachable', 'unresponsive', 'tls_failed', 'not_found', 'server_error', 'login_refused', 'forbidden', 'rate_limited', 'bad_answer');

ALTER TABLE "network"."panel"
    ADD COLUMN "panelStateCause" "network"."PanelFaultCause",
    ADD COLUMN "panelStateSince" TIMESTAMP(3),
    ADD COLUMN "panelCheckedAt" TIMESTAMP(3);

-- A cause only on a panel in trouble: a healthy row carrying one is a stale
-- reason shown beside a working panel.
ALTER TABLE "network"."panel"
    ADD CONSTRAINT "panel_state_cause_needs_trouble"
    CHECK ("panelStateCause" IS NULL OR "panelState" IN ('down', 'degraded', 'throttled_or_blocked'));
