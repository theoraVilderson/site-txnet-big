-- F-118-ab (D-59 (e)): a reseller's plan sold before F-118-p (or with no rate
-- on its own panels) has no `grant_wholesale` row. At its next renewal it
-- locks the package's rate in force then and is charged from that renewal on;
-- nothing is charged for the past.
--
-- `inherited`: the bag the plan still held when the leg was locked. It starts
-- `billed`, so only what the renewal adds is charged, and at close it is kept
-- (served first), never refunded. 0 on every row so far and on every leg
-- opened at a sale. Locked with the other terms.
--
-- Additive; rollback: DROP COLUMN "inherited", restore the previous
-- `grant_wholesale_terms_are_locked()` (20260930000200).

ALTER TABLE "entitlement"."grant_wholesale" ADD COLUMN "inherited" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "entitlement"."grant_wholesale" ADD CONSTRAINT "grant_wholesale_inherited_within_billed"
  CHECK ("inherited" >= 0 AND "inherited" <= "billed");

CREATE OR REPLACE FUNCTION entitlement.grant_wholesale_terms_are_locked() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'grant_wholesale_terms_are_locked: a Grant''s wholesale leg is never deleted'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."grantId" IS DISTINCT FROM OLD."grantId"
     OR NEW."payerTenantId" IS DISTINCT FROM OLD."payerTenantId"
     OR NEW."rateId" IS DISTINCT FROM OLD."rateId"
     OR NEW."meterKey" IS DISTINCT FROM OLD."meterKey"
     OR NEW."unitSize" IS DISTINCT FROM OLD."unitSize"
     OR NEW."unitPrice" IS DISTINCT FROM OLD."unitPrice"
     OR NEW."currencyCode" IS DISTINCT FROM OLD."currencyCode"
     OR NEW."inherited" IS DISTINCT FROM OLD."inherited"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'grant_wholesale_terms_are_locked: the rate a plan was sold at never changes; only its cursors move'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
