-- F-033-k — auto-close, rating, reopen (user, 2026-10-03).
--   * a thread waiting on the user (`pending_user`) or `resolved`, with no word
--     from the user for `autoCloseAfterDays`, is closed by the idle sweep;
--   * the user rates a resolved or closed thread once, 1–5, with an optional comment;
--   * a closed thread may be reopened by its user for `reopenWithinDays`.
-- Both days are the platform's 7 unless the tenant set its own
-- (`support.lifecycle_policy`, `PUT /api/support/settings/lifecycle`).
--
-- Additive; existing rows keep NULL ratings and `closedAutomatically = false`.
-- Rollback: DROP TABLE support.lifecycle_policy; drop the three columns and the CHECK.

ALTER TABLE "support"."conversation"
  ADD COLUMN "ratingComment" TEXT,
  ADD COLUMN "ratedAt" TIMESTAMP(3),
  ADD COLUMN "closedAutomatically" BOOLEAN NOT NULL DEFAULT false,
  ADD CONSTRAINT "conversation_rating_score" CHECK ("ratingScore" IS NULL OR "ratingScore" BETWEEN 1 AND 5),
  ADD CONSTRAINT "conversation_rating_comment" CHECK ("ratingComment" IS NULL OR char_length("ratingComment") <= 1000);

-- The idle sweep: unfinished-on-the-user's-side threads by how long they sat.
CREATE INDEX "conversation_idle_idx" ON "support"."conversation"("status", "lastMessageAt")
  WHERE "status" IN ('pending_user', 'resolved');

CREATE TABLE "support"."lifecycle_policy" (
    "tenantId" UUID NOT NULL,
    "autoCloseAfterDays" SMALLINT NOT NULL,
    "reopenWithinDays" SMALLINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lifecycle_policy_pkey" PRIMARY KEY ("tenantId"),
    CONSTRAINT "lifecycle_policy_auto_close" CHECK ("autoCloseAfterDays" BETWEEN 1 AND 90),
    CONSTRAINT "lifecycle_policy_reopen" CHECK ("reopenWithinDays" BETWEEN 0 AND 90)
);

ALTER TABLE support.lifecycle_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE support.lifecycle_policy FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON support.lifecycle_policy TO txnet_app, txnet_cross_tenant;
CREATE POLICY tenant_isolation ON support.lifecycle_policy
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON support.lifecycle_policy
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
