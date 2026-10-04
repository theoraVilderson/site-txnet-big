-- F-414-c (ADR-0117 point 1) — a guide is edited as a draft. `guide_translation`
-- stays the published text, the only one the reader serves; `guide_draft` holds
-- the edits in progress, the same shape and bounds. Publish replaces every
-- published language with the draft and deletes it. `publishedAt` is when that
-- last happened. Archive stays `isActive` — no state column.
--
-- Adds only: no row is rewritten or removed.
-- Rollback: DROP TABLE "guide"."guide_draft"; ALTER TABLE "guide"."guide" DROP COLUMN "publishedAt".

ALTER TABLE "guide"."guide" ADD COLUMN "publishedAt" TIMESTAMP(3);

CREATE TABLE "guide"."guide_draft" (
    "guideId" UUID NOT NULL,
    "tenantId" UUID,
    "lang" "identity"."Language" NOT NULL,
    "title" TEXT NOT NULL,
    "blocks" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guide_draft_pkey" PRIMARY KEY ("guideId", "lang"),
    CONSTRAINT "guide_draft_title" CHECK (char_length("title") BETWEEN 1 AND 120),
    CONSTRAINT "guide_draft_blocks" CHECK (
      jsonb_typeof("blocks") = 'array'
      AND jsonb_array_length("blocks") BETWEEN 1 AND 100
      AND octet_length("blocks"::text) <= 65536
    )
);

ALTER TABLE "guide"."guide_draft" ADD CONSTRAINT "guide_draft_guideId_fkey"
  FOREIGN KEY ("guideId") REFERENCES "guide"."guide"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Shared-read like the other four (invariant 1). A platform draft is NULL, and
-- a reseller's admin only ever asks for its own guide's.
ALTER TABLE "guide"."guide_draft" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "guide"."guide_draft" FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "guide"."guide_draft" TO txnet_app, txnet_cross_tenant;
CREATE POLICY tenant_isolation ON "guide"."guide_draft"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" IS NULL OR "tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON "guide"."guide_draft"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);

-- F-414-c — the permission the guide settings need, granted to `Admin` as
-- `support.manage` is (20261003001300). `prisma/seed.js` makes the same grant.
INSERT INTO identity.permission (id, key) VALUES (gen_random_uuid(), 'guide.manage')
ON CONFLICT (key) DO NOTHING;

INSERT INTO identity.role_permission ("roleId", "permissionId")
SELECT r.id, p.id
FROM identity.role r
JOIN identity.permission p ON p.key = 'guide.manage'
WHERE r.name = 'Admin'
ON CONFLICT DO NOTHING;
