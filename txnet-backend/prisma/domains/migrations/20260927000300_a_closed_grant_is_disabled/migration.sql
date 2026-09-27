-- F-027-dd — the lease planner closes a Grant by disabling it (SPEC §6-2).
--
-- A close is the planner's, not the owner's: `config.desiredEnabled` stays
-- billing's (a suspension, the user's own switch, a revive), and the panel's
-- client is enabled only while that is true AND its Grant has no row here.
-- The row keeps the Quota and end the Grant closed on, so a restarted planner
-- reopens only on a renewal past them with ReopenMin available — never on its
-- own forgetting.
--
-- Additive: a new table, empty until the planner closes a Grant. Rollback:
-- drop it; every config then reads as enabled by `desiredEnabled` alone.

CREATE TABLE "network"."lease_close" (
    "grantId" UUID NOT NULL,
    "quotaBytes" BIGINT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lease_close_pkey" PRIMARY KEY ("grantId")
);

ALTER TABLE "network"."lease_close" ADD CONSTRAINT "lease_close_grantId_fkey"
    FOREIGN KEY ("grantId") REFERENCES "entitlement"."grant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "network"."lease_close" ADD CONSTRAINT "lease_close_quota_not_negative" CHECK ("quotaBytes" >= 0);
