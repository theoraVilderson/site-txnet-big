-- F-707-b (ADR-0111 point 2). The reward issuer's record: one row per
-- (source, referenceId) — a spin attempt or a lottery winner — so a retried
-- spin or delivery answers what was given and never gives it twice. It names
-- what the prize became: the Grant and its quota adjustment or duration
-- change, the coupon, or the free Grant. Written once.
--
-- `engagement_reward` is the GrantSource of a prize's quota adjustment and of
-- a free Grant. Never cash: no wallet row is ever written for a prize.
--
-- Additive. Rollback: DROP TABLE engagement.reward_issue; DROP TYPE
-- engagement."RewardSource"; DROP FUNCTION engagement.reward_issue_is_history.
-- (An enum value cannot be dropped; `engagement_reward` stays, unused.)

ALTER TYPE "entitlement"."GrantSource" ADD VALUE IF NOT EXISTS 'engagement_reward';

CREATE TYPE "engagement"."RewardSource" AS ENUM ('spin', 'lottery');

CREATE TABLE "engagement"."reward_issue" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "source" "engagement"."RewardSource" NOT NULL,
    "referenceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "prizeType" "engagement"."SpinPrizeType" NOT NULL,
    "grantId" UUID,
    "quotaAdjustmentId" UUID,
    "durationChangeId" UUID,
    "couponId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reward_issue_pkey" PRIMARY KEY ("id"),
    -- What each kind leaves behind; never cash, never an empty slot.
    -- `prizeType::text`: compared as text, as `engagement.prize_shape_ok` does.
    CONSTRAINT "reward_issue_shape" CHECK (CASE "prizeType"::text
      WHEN 'bonus_traffic_gb' THEN "grantId" IS NOT NULL AND "quotaAdjustmentId" IS NOT NULL AND "durationChangeId" IS NULL AND "couponId" IS NULL
      WHEN 'extra_days'       THEN "grantId" IS NOT NULL AND "durationChangeId" IS NOT NULL AND "quotaAdjustmentId" IS NULL AND "couponId" IS NULL
      WHEN 'discount_coupon'  THEN "couponId" IS NOT NULL AND "grantId" IS NULL AND "quotaAdjustmentId" IS NULL AND "durationChangeId" IS NULL
      WHEN 'free_grant'       THEN "grantId" IS NOT NULL AND "quotaAdjustmentId" IS NULL AND "durationChangeId" IS NULL AND "couponId" IS NULL
      ELSE false END)
);

CREATE INDEX "reward_issue_tenantId_userId_idx" ON "engagement"."reward_issue"("tenantId", "userId");
CREATE UNIQUE INDEX "reward_issue_source_referenceId_key" ON "engagement"."reward_issue"("source", "referenceId");

CREATE FUNCTION engagement.reward_issue_is_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'reward_issue_is_history: a prize given is never changed or taken back here'
    USING ERRCODE = '23514';
END
$$;
CREATE TRIGGER reward_issue_is_history BEFORE UPDATE OR DELETE ON "engagement"."reward_issue"
  FOR EACH ROW EXECUTE FUNCTION engagement.reward_issue_is_history();

-- Its user is its tenant's (`engagement.same_tenant`, F-707-a).
CREATE OR REPLACE FUNCTION engagement.reward_issue_same_tenant() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM identity."user" WHERE id = NEW."userId" AND "tenantId" = NEW."tenantId") THEN
    RAISE EXCEPTION 'engagement_tenant_mismatch: reward_issue names a user that is not its tenant''s'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER reward_issue_same_tenant BEFORE INSERT ON "engagement"."reward_issue"
  FOR EACH ROW EXECUTE FUNCTION engagement.reward_issue_same_tenant();

ALTER TABLE "engagement"."reward_issue" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "engagement"."reward_issue" FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "engagement"."reward_issue" TO txnet_app, txnet_cross_tenant;
CREATE POLICY tenant_isolation ON "engagement"."reward_issue"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON "engagement"."reward_issue"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
