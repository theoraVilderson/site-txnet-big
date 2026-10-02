-- F-038-f3 (ADR-0110 points 1, 2): a personal coupon billing issues for an AI
-- suggestion. One per action — a retried delivery answers the same code and
-- charges the offer's budget once — and the charge is what the day's budget
-- sums. Additive: every existing coupon reads NULL in all three.

ALTER TABLE "billing"."coupon"
  ADD COLUMN "aiActionId" UUID,
  ADD COLUMN "aiOfferId" UUID,
  ADD COLUMN "aiBudgetCharge" DECIMAL(18,2);

ALTER TABLE "billing"."coupon"
  ADD CONSTRAINT "coupon_ai_offer_whole" CHECK (
    ("aiActionId" IS NULL AND "aiOfferId" IS NULL AND "aiBudgetCharge" IS NULL)
    OR ("aiActionId" IS NOT NULL AND "aiOfferId" IS NOT NULL AND "aiBudgetCharge" > 0)
  );

CREATE UNIQUE INDEX "coupon_aiActionId_key" ON "billing"."coupon"("aiActionId");
CREATE INDEX "coupon_aiOfferId_createdAt_idx" ON "billing"."coupon"("aiOfferId", "createdAt");
