-- KS-1-c (ADR-0140 (2)): `grant.compensate` adds days or traffic to a user's
-- service, up to a cap per Grant over a rolling 30 days that a `grant.assign`
-- holder sets for the tenant.
--
--   grant_compensation_cap — one row per tenant; none = the platform's default
--                            (in code). 0 closes that kind.
--   grant_compensation     — one row per compensation given: what the cap counts.
--
-- Strict tenant RLS, as every entitlement table. Every holder of `grant.assign`
-- (role, group, person — a take included) also gets `grant.compensate`, so the
-- split takes nothing from anyone (ADR-0140 (3)); the triggers notify on each
-- insert. Additive; rollback: DROP both tables, then delete the
-- `grant.compensate` permission rows (role_permission first).

-- A cap set or cleared is audited against the tenant.
ALTER TYPE "audit"."AdminAction" ADD VALUE 'grant_compensation_cap_set';

CREATE TABLE "entitlement"."grant_compensation_cap" (
    "tenantId" UUID NOT NULL,
    "days" INTEGER NOT NULL,
    "bytes" BIGINT NOT NULL,
    "updatedByUserId" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "grant_compensation_cap_pkey" PRIMARY KEY ("tenantId"),
    CONSTRAINT "grant_compensation_cap_not_negative" CHECK ("days" >= 0 AND "bytes" >= 0)
);

CREATE TABLE "entitlement"."grant_compensation" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "grantId" UUID NOT NULL,
    "actorUserId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "days" INTEGER NOT NULL DEFAULT 0,
    "bytes" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "grant_compensation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "grant_compensation_one_kind" CHECK (("days" > 0 AND "bytes" = 0) OR ("days" = 0 AND "bytes" > 0))
);

CREATE INDEX "grant_compensation_grantId_createdAt_idx" ON "entitlement"."grant_compensation"("grantId", "createdAt");

ALTER TABLE entitlement.grant_compensation_cap ENABLE ROW LEVEL SECURITY;
ALTER TABLE entitlement.grant_compensation_cap FORCE ROW LEVEL SECURITY;
ALTER TABLE entitlement.grant_compensation ENABLE ROW LEVEL SECURITY;
ALTER TABLE entitlement.grant_compensation FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "entitlement"."grant_compensation_cap", "entitlement"."grant_compensation" TO txnet_app, txnet_cross_tenant;

CREATE POLICY tenant_isolation ON "entitlement"."grant_compensation_cap"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON "entitlement"."grant_compensation_cap"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);

CREATE POLICY tenant_isolation ON "entitlement"."grant_compensation"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON "entitlement"."grant_compensation"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);

INSERT INTO identity.permission (id, key)
VALUES (gen_random_uuid(), 'grant.compensate')
ON CONFLICT (key) DO NOTHING;

INSERT INTO identity.role_permission ("roleId", "permissionId")
SELECT rp."roleId", np.id
FROM identity.role_permission rp
JOIN identity.permission op ON op.id = rp."permissionId" AND op.key = 'grant.assign'
CROSS JOIN identity.permission np
WHERE np.key = 'grant.compensate'
ON CONFLICT DO NOTHING;

INSERT INTO governance.user_group_permission ("groupId", "tenantId", "permissionId")
SELECT gp."groupId", gp."tenantId", np.id
FROM governance.user_group_permission gp
JOIN identity.permission op ON op.id = gp."permissionId" AND op.key = 'grant.assign'
CROSS JOIN identity.permission np
WHERE np.key = 'grant.compensate'
ON CONFLICT DO NOTHING;

INSERT INTO identity.user_permission ("userId", "permissionId", "tenantId", effect, reason, "grantedByUserId", "createdAt", "updatedAt")
SELECT up."userId", np.id, up."tenantId", up.effect, up.reason, up."grantedByUserId", up."createdAt", now()
FROM identity.user_permission up
JOIN identity.permission op ON op.id = up."permissionId" AND op.key = 'grant.assign'
CROSS JOIN identity.permission np
WHERE np.key = 'grant.compensate'
ON CONFLICT DO NOTHING;
