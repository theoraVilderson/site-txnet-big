-- F-307-j — a reseller's line-name template (ADR-0089 rule 4), e.g.
-- `{brand} · {region}`: the default name of every served line whose buyer
-- has not named its config. Null is the platform's `{region}`.
--
-- Evaluated per request by billing's config list and `/sub`; nothing is
-- stored per config, so a change needs no backfill. The CHECK holds the
-- storage edge of tenant-service's rule: trimmed, not empty (empty is null),
-- at most 40 characters. Which placeholders are allowed is the service's.
--
-- `/sub` caches renders (sub-api contract.md, the cache rule), so a changed
-- template, or a changed brand name while a template is set, stamps the
-- tenant, as a domain change does; the tenant stamp is already every
-- render's dependency.
--
-- Additive, no backfill. Rollback: drop the trigger, its function, the
-- constraint and the column.

ALTER TABLE "tenant"."tenant_branding" ADD COLUMN "lineNameTemplate" TEXT;

ALTER TABLE "tenant"."tenant_branding" ADD CONSTRAINT "tenant_branding_line_name_template_shape"
  CHECK ("lineNameTemplate" IS NULL OR ("lineNameTemplate" = btrim("lineNameTemplate") AND char_length("lineNameTemplate") BETWEEN 1 AND 40));

CREATE OR REPLACE FUNCTION tenant.notify_sub_line_naming_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW."lineNameTemplate" IS NOT NULL OR
     TG_OP IN ('UPDATE', 'DELETE') AND OLD."lineNameTemplate" IS NOT NULL THEN
    IF TG_OP = 'UPDATE' AND
       OLD."tenantId" IS NOT DISTINCT FROM NEW."tenantId" AND
       OLD."lineNameTemplate" IS NOT DISTINCT FROM NEW."lineNameTemplate" AND
       OLD."brandName" IS NOT DISTINCT FROM NEW."brandName" THEN
      RETURN NULL;
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
      PERFORM pg_notify('sub_invalidate', json_build_object('kind', 'tenant', 'id', NEW."tenantId")::text);
    END IF;
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
      PERFORM pg_notify('sub_invalidate', json_build_object('kind', 'tenant', 'id', OLD."tenantId")::text);
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER sub_line_naming_changed
  AFTER INSERT OR DELETE OR UPDATE OF "tenantId", "lineNameTemplate", "brandName"
  ON tenant.tenant_branding
  FOR EACH ROW EXECUTE FUNCTION tenant.notify_sub_line_naming_changed();
