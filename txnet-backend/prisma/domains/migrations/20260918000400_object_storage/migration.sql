-- F-018-m — object storage (D-42 (3), platform unit `object-storage`).
--
-- 1. A `storage` schema of its own: the files are a platform concern that
--    `tenant`, `support` and later owners cite by key; none of them owns it.
-- 2. `stored_object`: one row per file — key, tenant, type, size, sha256. The
--    key is the primary key and already carries the tenant
--    (`tenants/<tenantId>/...`), so a key can never be two tenants' file.
-- 3. Strict RLS, the shape of every tenant-owned table: a tenant reads its own
--    rows on the app pool, the cross-tenant pool reads all.
--
-- Rollback: `DROP SCHEMA storage CASCADE`. The bytes on the volume stay, and
-- are addressed by the same keys if the table is restored.

CREATE SCHEMA IF NOT EXISTS "storage";
GRANT USAGE ON SCHEMA storage TO txnet_app, txnet_cross_tenant;
ALTER DEFAULT PRIVILEGES IN SCHEMA storage GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO txnet_app, txnet_cross_tenant;
ALTER DEFAULT PRIVILEGES IN SCHEMA storage GRANT USAGE, SELECT ON SEQUENCES TO txnet_app, txnet_cross_tenant;

CREATE TABLE "storage"."stored_object" (
    "key" TEXT NOT NULL,
    "tenantId" UUID NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stored_object_pkey" PRIMARY KEY ("key"),
    -- The key's prefix and the column name one tenant; a row where they differ
    -- would be served on one tenant's domain and billed to another's.
    CONSTRAINT "stored_object_key_prefix" CHECK ("key" LIKE 'tenants/' || "tenantId"::text || '/%')
);

CREATE INDEX "stored_object_tenantId_idx" ON "storage"."stored_object"("tenantId");

ALTER TABLE "storage"."stored_object" ADD CONSTRAINT "stored_object_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"."tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE storage.stored_object ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.stored_object FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.stored_object TO txnet_app, txnet_cross_tenant;
CREATE POLICY tenant_isolation ON storage.stored_object
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON storage.stored_object
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
