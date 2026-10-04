-- F-414-a — guide storage (ADR-0115): help content per product, OS, app or
-- panel/bot section, a text per language, its placements. `tenantId` NULL is
-- the platform's, read by every tenant and written by none; a reseller's own
-- guide with the same key replaces it for that reseller, and a `guide_hidden`
-- row removes it. Shared-read RLS, as support's categories (ADR-0112 point 6).
--
-- Additive. Rollback: DROP SCHEMA guide CASCADE.

CREATE SCHEMA IF NOT EXISTS "guide";
GRANT USAGE ON SCHEMA guide TO txnet_app, txnet_cross_tenant;

CREATE TYPE "guide"."GuideKind" AS ENUM ('product', 'os', 'app', 'section');
CREATE TYPE "guide"."GuideSurface" AS ENUM ('panel', 'bot', 'any');
CREATE TYPE "guide"."GuideTargetKind" AS ENUM ('route', 'bot_screen', 'product', 'os', 'app');

CREATE TABLE "guide"."guide" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "key" TEXT NOT NULL,
    "kind" "guide"."GuideKind" NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "guide_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "guide_key_shape" CHECK ("key" ~ '^[a-z0-9_]{1,60}$')
);

CREATE TABLE "guide"."guide_translation" (
    "guideId" UUID NOT NULL,
    "tenantId" UUID,
    "lang" "identity"."Language" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,

    CONSTRAINT "guide_translation_pkey" PRIMARY KEY ("guideId","lang"),
    CONSTRAINT "guide_translation_title" CHECK (char_length("title") BETWEEN 1 AND 120),
    CONSTRAINT "guide_translation_body" CHECK (char_length("body") BETWEEN 1 AND 20000)
);

CREATE TABLE "guide"."guide_placement" (
    "id" UUID NOT NULL,
    "guideId" UUID NOT NULL,
    "tenantId" UUID,
    "surface" "guide"."GuideSurface" NOT NULL,
    "targetKind" "guide"."GuideTargetKind" NOT NULL,
    "targetRef" TEXT NOT NULL,

    CONSTRAINT "guide_placement_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "guide_placement_ref" CHECK (char_length("targetRef") BETWEEN 1 AND 200)
);

CREATE TABLE "guide"."guide_hidden" (
    "tenantId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guide_hidden_pkey" PRIMARY KEY ("tenantId","key")
);

CREATE UNIQUE INDEX "guide_tenantId_key_key" ON "guide"."guide"("tenantId", "key");
-- NULLs are distinct to a unique index: the platform's keys are held unique on their own.
CREATE UNIQUE INDEX "guide_platform_key" ON "guide"."guide"("key") WHERE "tenantId" IS NULL;
CREATE UNIQUE INDEX "guide_placement_guideId_surface_targetKind_targetRef_key"
  ON "guide"."guide_placement"("guideId", "surface", "targetKind", "targetRef");
CREATE INDEX "guide_placement_targetKind_targetRef_idx" ON "guide"."guide_placement"("targetKind", "targetRef");

ALTER TABLE "guide"."guide_translation" ADD CONSTRAINT "guide_translation_guideId_fkey"
  FOREIGN KEY ("guideId") REFERENCES "guide"."guide"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "guide"."guide_placement" ADD CONSTRAINT "guide_placement_guideId_fkey"
  FOREIGN KEY ("guideId") REFERENCES "guide"."guide"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Shared-read (invariant 1): the platform's rows (NULL) and the tenant's own;
-- a tenant never writes a NULL row. `guide_hidden` has no NULL rows at all.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['guide.guide', 'guide.guide_translation', 'guide.guide_placement', 'guide.guide_hidden']
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
