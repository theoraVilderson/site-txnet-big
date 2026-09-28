-- F-311-p — an admin caps a Grant's speed (Mbps).
--
-- One row per capped Grant, network's like `lease_close`: the cap is a fact
-- about what the panel must enforce, not about what was sold. Keyed by the
-- Grant, never copied onto its configs, so a config placed later — a move, a
-- group member, a rebuild — carries it with no writer having to remember.
-- No row is no cap. The convergence pass writes it through
-- `SetClientRateLimit` on a panel whose capability document answers
-- `per_client_rate_limit` yes, and nowhere else.
--
-- The row wakes every panel the Grant has a config on (F-111-j's channel), so
-- the cap reaches the panel in seconds, not on the next bulk pass.
--
-- Additive: a new table, empty until an admin caps a Grant. Rollback: drop the
-- trigger, the function and the table; every client is then written uncapped.

CREATE TABLE "network"."grant_rate_limit" (
    "grantId" UUID NOT NULL,
    "rateMbps" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "setByAdminId" UUID NOT NULL,
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "grant_rate_limit_pkey" PRIMARY KEY ("grantId")
);

ALTER TABLE "network"."grant_rate_limit" ADD CONSTRAINT "grant_rate_limit_grantId_fkey"
    FOREIGN KEY ("grantId") REFERENCES "entitlement"."grant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "network"."grant_rate_limit" ADD CONSTRAINT "grant_rate_limit_rate_positive"
    CHECK ("rateMbps" BETWEEN 1 AND 100000);

CREATE OR REPLACE FUNCTION network.notify_converge_grant_rate_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  g UUID := coalesce(NEW."grantId", OLD."grantId");
  p UUID;
BEGIN
  FOR p IN SELECT DISTINCT c."panelId" FROM network.config c
            WHERE c."grantId" = g AND c."desiredRemote" = 'present' LOOP
    PERFORM pg_notify('network_converge', p::text);
  END LOOP;
  RETURN NULL;
END
$$;

CREATE TRIGGER converge_grant_rate_changed
  AFTER INSERT OR UPDATE OF "rateMbps" OR DELETE
  ON network.grant_rate_limit
  FOR EACH ROW EXECUTE FUNCTION network.notify_converge_grant_rate_changed();
