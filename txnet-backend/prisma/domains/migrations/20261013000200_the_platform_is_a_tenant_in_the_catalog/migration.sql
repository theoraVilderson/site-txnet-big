-- PT-1-a (ADR-0142): the platform is a tenant, and its catalog rows carry its
-- id. Until now the platform's shared rows had "tenantId" NULL while the rows
-- its staff made from the panel carried the platform_owner tenant's id, so a
-- reader that knew one form missed the other.
--
--   public.platform_tenant_id() — the platform_owner tenant's id, one answer
--                                 for every policy, trigger and service.
--
-- On the ten catalog tables that had a nullable "tenantId": NULL becomes the
-- platform's id, the column becomes NOT NULL, the partial uniques (platform /
-- tenant) become one ("tenantId", key), and shared-read RLS reads the
-- platform's id instead of NULL. Writes are unchanged: a row is written only
-- as its own tenant. The triggers that let "the platform's" row be anyone's
-- parent (category, link, capability key, a Grant's variant) read the id too.
--
-- Only updates rows; deletes nothing. Rollback: the reverse UPDATE to NULL
-- after DROP NOT NULL, the previous policies, triggers and indexes.

CREATE OR REPLACE FUNCTION public.platform_tenant_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE PARALLEL SAFE
 SECURITY DEFINER
 SET search_path = pg_catalog, public
AS $function$
  SELECT id FROM tenant.tenant WHERE "tenantType" = 'platform_owner' LIMIT 1
$function$;

GRANT EXECUTE ON FUNCTION public.platform_tenant_id() TO txnet_app, txnet_cross_tenant, txnet_ai_reader;

-- The backfill rewrites "tenantId" only. The history triggers refuse any
-- change but isActive, and the same-tenant ones read rows the same statement
-- is moving, so they are off for the backfill alone.
ALTER TABLE catalog.price DISABLE TRIGGER price_is_history;
ALTER TABLE catalog.price DISABLE TRIGGER price_same_tenant;
ALTER TABLE catalog.rate_card DISABLE TRIGGER rate_card_is_history;
ALTER TABLE catalog.rate_card DISABLE TRIGGER rate_card_same_tenant;
ALTER TABLE catalog.price_campaign DISABLE TRIGGER price_campaign_same_tenant_as_parent;
ALTER TABLE catalog.season_price DISABLE TRIGGER season_price_same_tenant_as_parent;
ALTER TABLE catalog.product_variant DISABLE TRIGGER product_variant_same_tenant;
ALTER TABLE catalog.product_variant DISABLE TRIGGER product_variant_panel_group_fits;
ALTER TABLE catalog.product_category DISABLE TRIGGER product_category_parent_same_tenant;
ALTER TABLE catalog.product_category_link DISABLE TRIGGER product_category_link_same_tenant;
ALTER TABLE catalog.product_capability DISABLE TRIGGER product_capability_key_free;

UPDATE catalog.product_category      SET "tenantId" = public.platform_tenant_id() WHERE "tenantId" IS NULL;
UPDATE catalog.product_capability    SET "tenantId" = public.platform_tenant_id() WHERE "tenantId" IS NULL;
UPDATE catalog.product               SET "tenantId" = public.platform_tenant_id() WHERE "tenantId" IS NULL;
UPDATE catalog.product_category_link SET "tenantId" = public.platform_tenant_id() WHERE "tenantId" IS NULL;
UPDATE catalog.product_variant       SET "tenantId" = public.platform_tenant_id() WHERE "tenantId" IS NULL;
UPDATE catalog.price                 SET "tenantId" = public.platform_tenant_id() WHERE "tenantId" IS NULL;
UPDATE catalog.price_campaign        SET "tenantId" = public.platform_tenant_id() WHERE "tenantId" IS NULL;
UPDATE catalog.season                SET "tenantId" = public.platform_tenant_id() WHERE "tenantId" IS NULL;
UPDATE catalog.season_price          SET "tenantId" = public.platform_tenant_id() WHERE "tenantId" IS NULL;
UPDATE catalog.rate_card             SET "tenantId" = public.platform_tenant_id() WHERE "tenantId" IS NULL;

ALTER TABLE catalog.price ENABLE TRIGGER price_is_history;
ALTER TABLE catalog.price ENABLE TRIGGER price_same_tenant;
ALTER TABLE catalog.rate_card ENABLE TRIGGER rate_card_is_history;
ALTER TABLE catalog.rate_card ENABLE TRIGGER rate_card_same_tenant;
ALTER TABLE catalog.price_campaign ENABLE TRIGGER price_campaign_same_tenant_as_parent;
ALTER TABLE catalog.season_price ENABLE TRIGGER season_price_same_tenant_as_parent;
ALTER TABLE catalog.product_variant ENABLE TRIGGER product_variant_same_tenant;
ALTER TABLE catalog.product_variant ENABLE TRIGGER product_variant_panel_group_fits;
ALTER TABLE catalog.product_category ENABLE TRIGGER product_category_parent_same_tenant;
ALTER TABLE catalog.product_category_link ENABLE TRIGGER product_category_link_same_tenant;
ALTER TABLE catalog.product_capability ENABLE TRIGGER product_capability_key_free;

ALTER TABLE catalog.product_category      ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE catalog.product_capability    ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE catalog.product               ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE catalog.product_category_link ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE catalog.product_variant       ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE catalog.price                 ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE catalog.price_campaign        ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE catalog.season                ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE catalog.season_price          ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE catalog.rate_card             ALTER COLUMN "tenantId" SET NOT NULL;

-- One key space per tenant, the platform being one.
DROP INDEX catalog.product_category_platform_key;
DROP INDEX catalog.product_category_tenant_key;
CREATE UNIQUE INDEX product_category_tenant_key ON catalog.product_category ("tenantId", key);
DROP INDEX catalog.product_platform_key;
DROP INDEX catalog.product_tenant_key;
CREATE UNIQUE INDEX product_tenant_key ON catalog.product ("tenantId", key);
DROP INDEX catalog.product_variant_platform_sku;
DROP INDEX catalog.product_variant_tenant_sku;
CREATE UNIQUE INDEX product_variant_tenant_sku ON catalog.product_variant ("tenantId", sku);
DROP INDEX catalog.product_capability_platform_key;
DROP INDEX catalog.product_capability_tenant_key;
CREATE UNIQUE INDEX product_capability_tenant_key ON catalog.product_capability ("tenantId", key);

-- Shared-read: a tenant reads its own rows and the platform's.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['product_category', 'product_capability', 'product', 'product_category_link', 'product_variant',
                           'price', 'price_campaign', 'season', 'season_price', 'rate_card'] LOOP
    EXECUTE format('DROP POLICY tenant_isolation ON catalog.%I', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON catalog.%I
        AS PERMISSIVE FOR ALL TO txnet_app
        USING ("tenantId" = public.current_tenant_id() OR "tenantId" = public.platform_tenant_id())
        WITH CHECK ("tenantId" = public.current_tenant_id())
    $p$, t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['product', 'product_variant', 'price', 'price_campaign', 'season'] LOOP
    EXECUTE format('DROP POLICY ai_reader ON catalog.%I', t);
    EXECUTE format($p$
      CREATE POLICY ai_reader ON catalog.%I
        AS PERMISSIVE FOR SELECT TO txnet_ai_reader
        USING ("tenantId" = public.current_tenant_id() OR "tenantId" = public.platform_tenant_id())
    $p$, t);
  END LOOP;
END
$$;

CREATE OR REPLACE FUNCTION catalog.category_parent_ok()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  parent_tenant uuid;
  cursor_id uuid;
  steps int := 0;
BEGIN
  IF NEW."parentId" IS NULL THEN
    RETURN NEW;
  END IF;
  -- One re-parent at a time: the walk below is only sound if no other
  -- transaction is moving a category while it runs.
  PERFORM pg_advisory_xact_lock(hashtext('catalog.category_tree'));

  SELECT "tenantId" INTO parent_tenant FROM catalog.product_category WHERE id = NEW."parentId";
  -- The platform's category holds anyone's children; a tenant's only its own.
  IF NOT FOUND OR NOT (parent_tenant = public.platform_tenant_id() OR parent_tenant = NEW."tenantId") THEN
    RAISE EXCEPTION 'catalog_tenant_mismatch: product_category % must sit under its tenant''s category or the platform''s', NEW.id
      USING ERRCODE = '23514';
  END IF;

  cursor_id := NEW."parentId";
  WHILE cursor_id IS NOT NULL LOOP
    IF cursor_id = NEW.id THEN
      RAISE EXCEPTION 'category_cycle: product_category % would sit under itself', NEW.id
        USING ERRCODE = '23514';
    END IF;
    steps := steps + 1;
    IF steps > 1000 THEN
      RAISE EXCEPTION 'category_cycle: the tree above product_category % does not end', NEW.id
        USING ERRCODE = '23514';
    END IF;
    SELECT "parentId" INTO cursor_id FROM catalog.product_category WHERE id = cursor_id;
  END LOOP;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION catalog.category_link_ok()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  product_tenant uuid;
  category_tenant uuid;
BEGIN
  SELECT "tenantId" INTO product_tenant FROM catalog.product WHERE id = NEW."productId";
  IF FOUND AND product_tenant = NEW."tenantId" THEN
    SELECT "tenantId" INTO category_tenant FROM catalog.product_category WHERE id = NEW."categoryId";
    IF FOUND AND (category_tenant = public.platform_tenant_id() OR category_tenant = NEW."tenantId") THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'catalog_tenant_mismatch: product_category_link %/% must carry its product''s tenant and a category it may sit in', NEW."productId", NEW."categoryId"
    USING ERRCODE = '23514';
END
$function$;

-- A capability key is unique among what one tenant sees: its own and the platform's.
CREATE OR REPLACE FUNCTION catalog.capability_key_free()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  platform uuid := public.platform_tenant_id();
BEGIN
  IF NEW."tenantId" <> platform AND EXISTS (
    SELECT 1 FROM catalog.product_capability WHERE "tenantId" = platform AND "key" = NEW."key"
  ) THEN
    RAISE EXCEPTION 'capability_key_taken: % is a platform capability', NEW."key"
      USING ERRCODE = '23514';
  END IF;
  IF NEW."tenantId" = platform AND EXISTS (
    SELECT 1 FROM catalog.product_capability WHERE "tenantId" <> platform AND "key" = NEW."key"
  ) THEN
    RAISE EXCEPTION 'capability_key_taken: a tenant already has %', NEW."key"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION entitlement.same_tenant()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  owner_tenant uuid;
BEGIN
  IF TG_TABLE_NAME = 'grant' THEN
    SELECT "tenantId" INTO owner_tenant FROM identity."user" WHERE id = NEW."userId";
    IF FOUND AND owner_tenant = NEW."tenantId" THEN
      IF NEW."variantId" IS NULL THEN
        RETURN NEW;
      END IF;
      -- The platform's variant is sold by every tenant; a tenant's only by that tenant.
      SELECT "tenantId" INTO owner_tenant FROM catalog.product_variant WHERE id = NEW."variantId";
      IF FOUND AND (owner_tenant = public.platform_tenant_id() OR owner_tenant = NEW."tenantId") THEN
        RETURN NEW;
      END IF;
    END IF;
  ELSE
    -- quota_adjustment, network.config: their Grant's tenant.
    SELECT "tenantId" INTO owner_tenant FROM entitlement."grant" WHERE id = NEW."grantId";
    IF FOUND AND owner_tenant = NEW."tenantId" THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'entitlement_tenant_mismatch: % % must be its tenant''s', TG_TABLE_NAME, NEW.id
    USING ERRCODE = '23514';
END
$function$;

-- Only a platform product is listed in a package: a reseller's own is its own business.
CREATE OR REPLACE FUNCTION tenant.package_product_is_platform() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM catalog.product WHERE id = NEW."productId" AND "tenantId" <> public.platform_tenant_id()) THEN
    RAISE EXCEPTION 'package_product_not_platform' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
