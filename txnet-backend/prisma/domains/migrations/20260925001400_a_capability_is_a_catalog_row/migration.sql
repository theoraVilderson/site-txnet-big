-- F-114-f-a (D-44, ADR-0086): the capabilities a product may unlock are rows,
-- not whatever string a product happened to carry. `tenantId` null is the
-- platform's, seen by every tenant; a set one is that tenant's own. A key is
-- unique among what one tenant can see — its own rows and the platform's —
-- and never changes once written: products and Grants hold it as a string.
--
-- Whether a product's `featureKeys` name rows its tenant can see, and whether a
-- row is still held when deleted, is decided in code under row locks
-- (`CatalogAdminService`), as a category's depth is.

ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'catalog_capability_create';
ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'catalog_capability_update';
ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'catalog_capability_delete';
ALTER TYPE "audit"."AuditTargetType" ADD VALUE IF NOT EXISTS 'product_capability';

CREATE TABLE "catalog"."product_capability" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "key" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "descriptionKey" TEXT,
    "sourceLang" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_capability_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "product_capability_tenantId_idx" ON "catalog"."product_capability"("tenantId");
CREATE UNIQUE INDEX "product_capability_tenant_key" ON "catalog"."product_capability"("tenantId", "key") WHERE "tenantId" IS NOT NULL;
CREATE UNIQUE INDEX "product_capability_platform_key" ON "catalog"."product_capability"("key") WHERE "tenantId" IS NULL;

-- -----------------------------------------------------------------------------
-- Keys in use (ADR-0086 decision 5). A key any platform product carries is the
-- platform's, so every tenant already selling it keeps it. Any other key a
-- product or a Grant carries becomes a row of each tenant that holds it. The
-- name starts as the key; a human names it afterwards. Only a key in the shape
-- a capability has (`vpn.access`, what product writes have required since
-- F-026-d) is copied: a Grant holding any other keeps it, as it keeps every key.
-- -----------------------------------------------------------------------------
INSERT INTO "catalog"."product_capability" ("id", "tenantId", "key", "nameKey")
  SELECT gen_random_uuid(), NULL, k, 'catalog.capability.' || k || '.name'
  FROM (SELECT DISTINCT unnest("featureKeys") AS k FROM "catalog"."product" WHERE "tenantId" IS NULL) p
  WHERE k ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$';

INSERT INTO "catalog"."product_capability" ("id", "tenantId", "key", "nameKey")
  SELECT gen_random_uuid(), t, k, 'catalog.t_' || replace(t::text, '-', '') || '.capability.' || k || '.name'
  FROM (
    SELECT DISTINCT "tenantId" AS t, unnest("featureKeys") AS k FROM "catalog"."product" WHERE "tenantId" IS NOT NULL
    UNION
    SELECT DISTINCT "tenantId", unnest("featureKeys") FROM "entitlement"."grant"
  ) held
  WHERE k ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'
    AND NOT EXISTS (SELECT 1 FROM "catalog"."product_capability" c WHERE c."tenantId" IS NULL AND c."key" = held.k);

-- A tenant's key may not shadow a platform key written later: the platform's
-- create is refused while any tenant holds the key (code), and here a tenant
-- row is refused while the platform holds it.
CREATE FUNCTION catalog.capability_key_free() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."tenantId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM catalog.product_capability WHERE "tenantId" IS NULL AND "key" = NEW."key"
  ) THEN
    RAISE EXCEPTION 'capability_key_taken: % is a platform capability', NEW."key"
      USING ERRCODE = '23514';
  END IF;
  IF NEW."tenantId" IS NULL AND EXISTS (
    SELECT 1 FROM catalog.product_capability WHERE "tenantId" IS NOT NULL AND "key" = NEW."key"
  ) THEN
    RAISE EXCEPTION 'capability_key_taken: a tenant already has %', NEW."key"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER product_capability_key_free BEFORE INSERT OR UPDATE OF "tenantId", "key" ON "catalog"."product_capability"
  FOR EACH ROW EXECUTE FUNCTION catalog.capability_key_free();

-- -----------------------------------------------------------------------------
-- Row-Level Security: shared-read, as product_category
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'catalog.product_capability'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO txnet_app, txnet_cross_tenant', t);

    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %s
        AS PERMISSIVE FOR ALL TO txnet_app
        USING ("tenantId" IS NULL OR "tenantId" = public.current_tenant_id())
        WITH CHECK ("tenantId" = public.current_tenant_id())
    $p$, t);

    EXECUTE format($p$
      CREATE POLICY cross_tenant ON %s
        AS PERMISSIVE FOR ALL TO txnet_cross_tenant
        USING (true) WITH CHECK (true)
    $p$, t);
  END LOOP;
END
$$;
