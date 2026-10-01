-- F-019-v3 (ADR-0107 point 8, user 2026-10-01): a reseller's quota terms
-- (included number, stop/overage, unit price) hold for the subscription period
-- it paid for. The platform's change against it applies from the next period;
-- one in its favour at once (each part read as the kinder of locked and live).
--
--   reseller_quota_terms_lock — one row per (tenant, key, periodEnd): the terms
--                               in force just before the platform first changed
--                               them in that period. Insert only. Strict tenant RLS.
--
-- Additive; rollback: DROP TABLE "tenant"."reseller_quota_terms_lock".

CREATE TABLE "tenant"."reseller_quota_terms_lock" (
    "tenantId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "included" INTEGER,
    "includedSource" TEXT NOT NULL,
    "mode" "tenant"."QuotaOverageMode" NOT NULL,
    "unitPrice" DECIMAL(18,2),
    "currencyCode" TEXT,
    "overageSource" TEXT NOT NULL,
    "lockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reseller_quota_terms_lock_pkey" PRIMARY KEY ("tenantId", "key", "periodEnd"),
    CONSTRAINT "reseller_quota_terms_lock_key_shape" CHECK ("key" ~ '^[a-z][a-z0-9_]{0,63}$'),
    CONSTRAINT "reseller_quota_terms_lock_included" CHECK ("included" IS NULL OR "included" >= 0),
    CONSTRAINT "reseller_quota_terms_lock_sources" CHECK (
        "includedSource" IN ('reseller', 'package', 'platform', 'default')
    AND "overageSource" IN ('reseller', 'package', 'platform', 'default')),
    CONSTRAINT "reseller_quota_terms_lock_priced_iff_overage" CHECK (
        ("mode" = 'stop' AND "unitPrice" IS NULL AND "currencyCode" IS NULL)
     OR ("mode" = 'overage' AND "unitPrice" > 0 AND "currencyCode" ~ '^[A-Z]{3}$'))
);

ALTER TABLE "tenant"."reseller_quota_terms_lock" ADD CONSTRAINT "reseller_quota_terms_lock_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"."tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Written once per period; only the platform currency change converts its price (F-019-v3).
ALTER TABLE tenant.reseller_quota_terms_lock ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.reseller_quota_terms_lock FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant.reseller_quota_terms_lock
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON tenant.reseller_quota_terms_lock
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
