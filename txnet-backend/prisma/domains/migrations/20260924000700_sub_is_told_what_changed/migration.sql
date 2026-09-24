-- F-113-c (ADR-0083) — Postgres tells `sub-service` when a cached `/sub`
-- render may have gone stale, so the cache is invalidated at once instead of
-- when its TTL runs out (catalog §7.5, C-07).
--
-- A trigger rather than application code, because the rows that decide a
-- render are written by three processes in two languages — network-service
-- (Go: panel state, captured link lines), tenant-service (TypeScript: domains),
-- billing-service (TypeScript: the Grant) — and by hand. A trigger is the one
-- writer that sees all of them, including the ones not written yet.
--
-- NOTIFY is delivered only after the writing transaction commits, and
-- identical payloads inside one transaction are folded into one, so a pass
-- that rewrites fifty configs of one Grant wakes the listener once for it.
--
-- One channel, `sub_invalidate`; the payload is JSON with ids only:
--   {"kind":"panel","id":<panelId>}    a panel's `panelState` changed
--   {"kind":"grant","id":<grantId>}    a config of the Grant, or the Grant itself
--   {"kind":"tenant","id":<tenantId>}  one of the tenant's domains
-- `sub-service` turns each into an INCR of that id's generation key
-- (redis-keyspace `sub:gen:*`); a cached render built under an older
-- generation is not served.
--
-- Only the columns a render reads fire, and only when they actually change:
-- the collector writes usage onto `network.config` every pass, and a
-- notification per write would empty the cache it exists to fill.
--
-- Rollback: drop the four triggers and the four functions. Nothing else
-- depends on them; without them a cached render lives until its TTL.

CREATE OR REPLACE FUNCTION network.notify_sub_panel_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM pg_notify('sub_invalidate', json_build_object('kind', 'panel', 'id', OLD.id)::text);
  ELSIF OLD."panelState" IS DISTINCT FROM NEW."panelState" THEN
    PERFORM pg_notify('sub_invalidate', json_build_object('kind', 'panel', 'id', NEW.id)::text);
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER sub_panel_changed
  AFTER UPDATE OF "panelState" OR DELETE ON network.panel
  FOR EACH ROW EXECUTE FUNCTION network.notify_sub_panel_changed();

-- A config created, removed, moved, frozen, re-keyed or re-captured. A config
-- moved to another Grant changes both, so both are named.
CREATE OR REPLACE FUNCTION network.notify_sub_config_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND
     OLD."grantId" IS NOT DISTINCT FROM NEW."grantId" AND
     OLD."panelId" IS NOT DISTINCT FROM NEW."panelId" AND
     OLD.status IS NOT DISTINCT FROM NEW.status AND
     OLD."desiredRemote" IS NOT DISTINCT FROM NEW."desiredRemote" AND
     OLD.uuid IS NOT DISTINCT FROM NEW.uuid AND
     OLD."linkLines" IS NOT DISTINCT FROM NEW."linkLines" AND
     OLD."linksUuid" IS NOT DISTINCT FROM NEW."linksUuid" THEN
    RETURN NULL;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM pg_notify('sub_invalidate', json_build_object('kind', 'grant', 'id', NEW."grantId")::text);
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM pg_notify('sub_invalidate', json_build_object('kind', 'grant', 'id', OLD."grantId")::text);
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER sub_config_changed
  AFTER INSERT OR DELETE OR UPDATE OF "grantId", "panelId", status, "desiredRemote", uuid, "linkLines", "linksUuid"
  ON network.config
  FOR EACH ROW EXECUTE FUNCTION network.notify_sub_config_changed();

-- The Grant itself: its status (F-609 serves an inactive Grant an empty
-- body), its token (a rotated token stops answering, F-113-d) and its tenant.
CREATE OR REPLACE FUNCTION entitlement.notify_sub_grant_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR
     OLD.status IS DISTINCT FROM NEW.status OR
     OLD."subscriptionTokenHash" IS DISTINCT FROM NEW."subscriptionTokenHash" OR
     OLD."tenantId" IS DISTINCT FROM NEW."tenantId" THEN
    PERFORM pg_notify('sub_invalidate', json_build_object('kind', 'grant', 'id', OLD.id)::text);
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER sub_grant_changed
  AFTER UPDATE OF status, "subscriptionTokenHash", "tenantId" OR DELETE ON entitlement."grant"
  FOR EACH ROW EXECUTE FUNCTION entitlement.notify_sub_grant_changed();

-- A domain added, removed, verified, failed, re-purposed or handed to another
-- tenant. Probe bookkeeping (`lastProbeAt`, …) does not fire.
CREATE OR REPLACE FUNCTION tenant.notify_sub_domain_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND
     OLD."tenantId" IS NOT DISTINCT FROM NEW."tenantId" AND
     OLD."domainValue" IS NOT DISTINCT FROM NEW."domainValue" AND
     OLD.purpose IS NOT DISTINCT FROM NEW.purpose AND
     OLD."domainType" IS NOT DISTINCT FROM NEW."domainType" AND
     OLD."verificationStatus" IS NOT DISTINCT FROM NEW."verificationStatus" THEN
    RETURN NULL;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM pg_notify('sub_invalidate', json_build_object('kind', 'tenant', 'id', NEW."tenantId")::text);
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM pg_notify('sub_invalidate', json_build_object('kind', 'tenant', 'id', OLD."tenantId")::text);
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER sub_domain_changed
  AFTER INSERT OR DELETE OR UPDATE OF "tenantId", "domainValue", purpose, "domainType", "verificationStatus"
  ON tenant.tenant_domain
  FOR EACH ROW EXECUTE FUNCTION tenant.notify_sub_domain_changed();
