-- F-027-aq — a connection test that gives no verdict says why (ADR-0080).
--
-- Registration is desired state: `billing-service` writes a panel `pending`
-- and `network-service` runs the questionnaire on its own tick. A panel it
-- could not reach, or that refused our credentials, did not answer — it is not
-- `refused`, which is a finding about what a panel can do — so it stays
-- `pending`, and the systems page needs the reason. The fault lives only on a
-- pending panel; a verdict or a re-submission clears it, hence the CHECK.
--
-- Additive and nullable: no backfill. Rollback: drop the constraint, the three
-- columns and the type.

CREATE TYPE "network"."ConnectionTestFault" AS ENUM ('timeout', 'rate_limited', 'blocked', 'unavailable', 'unsupported', 'protocol', 'unopenable', 'invalid_answers');

ALTER TABLE "network"."panel"
    ADD COLUMN "connectionTestedAt" TIMESTAMP(3),
    ADD COLUMN "connectionTestFault" "network"."ConnectionTestFault",
    ADD COLUMN "connectionTestDetail" TEXT;

ALTER TABLE "network"."panel"
    ADD CONSTRAINT "panel_connection_fault_is_pending_only"
    CHECK ("connectionTestFault" IS NULL
           OR ("connectionTestedAt" IS NOT NULL AND "reviewState" = 'pending'));
