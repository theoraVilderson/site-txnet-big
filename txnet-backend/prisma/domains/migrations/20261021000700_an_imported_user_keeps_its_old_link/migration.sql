-- F-203-a (D-63): an imported user's old subscription link keeps working.
--
--   legacy_sub_link — the host and path the source panel served a client's
--                     subscription at, and the Grant the import issued for
--                     it. sub-service answers that path with the Grant's
--                     current subscription (F-203-b) once the old host points
--                     here (F-204). Written by the commit, removed by the
--                     rollback and by a link reset. One Grant per path in a
--                     tenant: a second client of the same path is left out.
--
-- Additive; rollback: drop the table.

CREATE TABLE "entitlement"."legacy_sub_link" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "host" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "grantId" UUID NOT NULL,
    "migrationItemId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legacy_sub_link_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "legacy_sub_link_path_is_a_path" CHECK (left("path", 1) = '/' AND "path" <> '/'),
    CONSTRAINT "legacy_sub_link_host_is_normalised" CHECK ("host" <> '' AND "host" = lower("host"))
);

CREATE UNIQUE INDEX "legacy_sub_link_tenantId_host_path_key" ON "entitlement"."legacy_sub_link"("tenantId", "host", "path");
CREATE INDEX "legacy_sub_link_grantId_idx" ON "entitlement"."legacy_sub_link"("grantId");

ALTER TABLE "entitlement"."legacy_sub_link" ADD CONSTRAINT "legacy_sub_link_grantId_fkey"
    FOREIGN KEY ("grantId") REFERENCES "entitlement"."grant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- Tenant data, as its Grant
-- -----------------------------------------------------------------------------
ALTER TABLE entitlement.legacy_sub_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE entitlement.legacy_sub_link FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "entitlement"."legacy_sub_link" TO txnet_app, txnet_cross_tenant;

CREATE POLICY tenant_isolation ON "entitlement"."legacy_sub_link"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON "entitlement"."legacy_sub_link"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
