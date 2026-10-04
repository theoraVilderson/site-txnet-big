-- F-414-l (ADR-0119) — guide views per day and helpful votes, counted per
-- **reading** tenant by the id of the guide it showed (which may be the
-- platform's). Strict RLS on the reading tenant: a reseller sees only its own
-- numbers; the platform owner reads the platform guides' on the cross-tenant pool.
--
-- Adds only: no row is rewritten or removed.
-- Rollback: DROP TABLE "guide"."guide_vote", "guide"."guide_view_daily"; DROP TYPE "guide"."GuideViewSurface".

CREATE TYPE "guide"."GuideViewSurface" AS ENUM ('panel', 'bot');

CREATE TABLE "guide"."guide_view_daily" (
    "tenantId" UUID NOT NULL,
    "guideId" UUID NOT NULL,
    "day" DATE NOT NULL,
    "surface" "guide"."GuideViewSurface" NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "guide_view_daily_pkey" PRIMARY KEY ("tenantId", "guideId", "day", "surface"),
    CONSTRAINT "guide_view_daily_views" CHECK ("views" >= 0)
);

CREATE TABLE "guide"."guide_vote" (
    "tenantId" UUID NOT NULL,
    "guideId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "helpful" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "guide_vote_pkey" PRIMARY KEY ("tenantId", "guideId", "userId")
);

CREATE INDEX "guide_view_daily_guideId_day_idx" ON "guide"."guide_view_daily"("guideId", "day");
CREATE INDEX "guide_vote_guideId_idx" ON "guide"."guide_vote"("guideId");

ALTER TABLE "guide"."guide_view_daily" ADD CONSTRAINT "guide_view_daily_guideId_fkey"
  FOREIGN KEY ("guideId") REFERENCES "guide"."guide"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "guide"."guide_vote" ADD CONSTRAINT "guide_vote_guideId_fkey"
  FOREIGN KEY ("guideId") REFERENCES "guide"."guide"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Strict, unlike the other five: a reading tenant's numbers are its own, and no row is NULL.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['guide.guide_view_daily', 'guide.guide_vote']
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO txnet_app, txnet_cross_tenant', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %s
        AS PERMISSIVE FOR ALL TO txnet_app
        USING ("tenantId" = public.current_tenant_id())
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
