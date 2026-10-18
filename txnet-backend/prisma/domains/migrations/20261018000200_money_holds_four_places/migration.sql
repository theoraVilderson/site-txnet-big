-- F-116-q (ADR-0153 point 6): money holds four places, so a currency of three
-- (KWD, BHD, OMR) can be registered; a row still holds only its currency's own
-- places, which every writer rounds to (F-116-p). Widening keeps every stored
-- value and every reader: a running service reads and writes the same decimals,
-- so this is one step, not expand/contract. Done before production, while the
-- tables are near empty — each ALTER rewrites its table.

-- The AI reader's views read some of these columns, and Postgres retypes no
-- column a view depends on: each is kept as it is defined now, dropped, and
-- rebuilt below with the same options and grant.
CREATE TEMP TABLE money_scale_views AS
  SELECT c.relname AS name, pg_get_viewdef(c.oid) AS definition
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'ai' AND c.relkind = 'v'
     AND c.relname IN ('reader_billing_event', 'reader_reseller', 'reader_wallet', 'reader_wholesale_spend');

DO $$
DECLARE v record;
BEGIN
  IF (SELECT count(*) FROM money_scale_views) <> 4 THEN
    RAISE EXCEPTION 'expected the four ai.reader_* views that read money columns';
  END IF;
  FOR v IN SELECT name FROM money_scale_views LOOP
    EXECUTE format('DROP VIEW ai.%I', v.name);
  END LOOP;
END $$;

-- Nor one a trigger names in `UPDATE OF`: the wallet's held-amount check is
-- dropped and rebuilt below exactly as it is (F-118-a).
DROP TRIGGER wallet_matches_holds ON billing.wallet;

ALTER TABLE "ai"."action"
  ALTER COLUMN "convertedAmount" TYPE DECIMAL(20,4), -- contract: F-116-q
  ALTER COLUMN "expectedMargin" TYPE DECIMAL(20,4); -- contract: F-116-q

ALTER TABLE "ai"."offer"
  ALTER COLUMN "dailyBudget" TYPE DECIMAL(20,4); -- contract: F-116-q

ALTER TABLE "billing"."affiliate_commission"
  ALTER COLUMN "commissionAmount" TYPE DECIMAL(20,4); -- contract: F-116-q

ALTER TABLE "billing"."analytics_loss_alert"
  ALTER COLUMN "cost" TYPE DECIMAL(20,4), -- contract: F-116-q
  ALTER COLUMN "net" TYPE DECIMAL(20,4); -- contract: F-116-q

ALTER TABLE "billing"."analytics_payment_day"
  ALTER COLUMN "giftsCredited" TYPE DECIMAL(20,4), -- contract: F-116-q
  ALTER COLUMN "settledAmount" TYPE DECIMAL(20,4); -- contract: F-116-q

ALTER TABLE "billing"."analytics_sales_day"
  ALTER COLUMN "discounts" TYPE DECIMAL(20,4), -- contract: F-116-q
  ALTER COLUMN "gross" TYPE DECIMAL(20,4), -- contract: F-116-q
  ALTER COLUMN "net" TYPE DECIMAL(20,4), -- contract: F-116-q
  ALTER COLUMN "refunds" TYPE DECIMAL(20,4); -- contract: F-116-q

ALTER TABLE "billing"."analytics_user_day"
  ALTER COLUMN "net" TYPE DECIMAL(20,4), -- contract: F-116-q
  ALTER COLUMN "topUps" TYPE DECIMAL(20,4); -- contract: F-116-q

ALTER TABLE "billing"."coupon_redemption"
  ALTER COLUMN "discountAppliedAmount" TYPE DECIMAL(20,4); -- contract: F-116-q

ALTER TABLE "billing"."coupon"
  ALTER COLUMN "aiBudgetCharge" TYPE DECIMAL(20,4), -- contract: F-116-q
  ALTER COLUMN "discountValue" TYPE DECIMAL(20,4), -- contract: F-116-q
  ALTER COLUMN "maxDiscountCap" TYPE DECIMAL(20,4), -- contract: F-116-q
  ALTER COLUMN "maxPurchaseAmount" TYPE DECIMAL(20,4), -- contract: F-116-q
  ALTER COLUMN "minPurchaseAmount" TYPE DECIMAL(20,4); -- contract: F-116-q

ALTER TABLE "billing"."discount_rule"
  ALTER COLUMN "value" TYPE DECIMAL(20,4); -- contract: F-116-q

ALTER TABLE "billing"."gateway_settlement_entry"
  ALTER COLUMN "amount" TYPE DECIMAL(20,4); -- contract: F-116-q

ALTER TABLE "billing"."gateway_settlement_payout"
  ALTER COLUMN "amount" TYPE DECIMAL(20,4); -- contract: F-116-q

ALTER TABLE "billing"."invoice"
  ALTER COLUMN "amount" TYPE DECIMAL(20,4), -- contract: F-116-q
  ALTER COLUMN "discount" TYPE DECIMAL(20,4), -- contract: F-116-q
  ALTER COLUMN "ruleDiscount" TYPE DECIMAL(20,4), -- contract: F-116-q
  ALTER COLUMN "total" TYPE DECIMAL(20,4); -- contract: F-116-q

ALTER TABLE "billing"."payment_gateway"
  ALTER COLUMN "feeCeiling" TYPE DECIMAL(20,4), -- contract: F-116-q
  ALTER COLUMN "feeFloor" TYPE DECIMAL(20,4), -- contract: F-116-q
  ALTER COLUMN "maxAcceptAmount" TYPE DECIMAL(20,4), -- contract: F-116-q
  ALTER COLUMN "minAcceptAmount" TYPE DECIMAL(20,4); -- contract: F-116-q

ALTER TABLE "billing"."payment_transaction"
  ALTER COLUMN "amountCredited" TYPE DECIMAL(20,4), -- contract: F-116-q
  ALTER COLUMN "amountRequested" TYPE DECIMAL(20,4), -- contract: F-116-q
  ALTER COLUMN "discountApplied" TYPE DECIMAL(20,4), -- contract: F-116-q
  ALTER COLUMN "feeApplied" TYPE DECIMAL(20,4), -- contract: F-116-q
  ALTER COLUMN "taxApplied" TYPE DECIMAL(20,4); -- contract: F-116-q

ALTER TABLE "billing"."spending_cap"
  ALTER COLUMN "amount" TYPE DECIMAL(20,4), -- contract: F-116-q
  ALTER COLUMN "spent" TYPE DECIMAL(20,4); -- contract: F-116-q

ALTER TABLE "billing"."usage_authorization"
  ALTER COLUMN "heldAmount" TYPE DECIMAL(20,4); -- contract: F-116-q

ALTER TABLE "billing"."wallet_hold"
  ALTER COLUMN "amount" TYPE DECIMAL(20,4), -- contract: F-116-q
  ALTER COLUMN "captured" TYPE DECIMAL(20,4); -- contract: F-116-q

ALTER TABLE "billing"."wallet_transaction"
  ALTER COLUMN "amount" TYPE DECIMAL(20,4), -- contract: F-116-q
  ALTER COLUMN "balanceAfter" TYPE DECIMAL(20,4), -- contract: F-116-q
  ALTER COLUMN "sourceAmount" TYPE DECIMAL(20,4); -- contract: F-116-q

ALTER TABLE "billing"."wallet_transfer_request"
  ALTER COLUMN "amount" TYPE DECIMAL(20,4); -- contract: F-116-q

ALTER TABLE "billing"."wallet"
  ALTER COLUMN "cachedBalance" TYPE DECIMAL(20,4), -- contract: F-116-q
  ALTER COLUMN "heldAmount" TYPE DECIMAL(20,4); -- contract: F-116-q

ALTER TABLE "catalog"."price_campaign"
  ALTER COLUMN "amount" TYPE DECIMAL(20,4); -- contract: F-116-q

ALTER TABLE "catalog"."price"
  ALTER COLUMN "amount" TYPE DECIMAL(20,4); -- contract: F-116-q

ALTER TABLE "catalog"."season_price"
  ALTER COLUMN "amount" TYPE DECIMAL(20,4); -- contract: F-116-q

ALTER TABLE "catalog"."variant_cost"
  ALTER COLUMN "amount" TYPE DECIMAL(20,4); -- contract: F-116-q

ALTER TABLE "engagement"."lottery_prize"
  ALTER COLUMN "prizeValue" TYPE DECIMAL(20,4); -- contract: F-116-q

ALTER TABLE "engagement"."spin_wheel_attempt"
  ALTER COLUMN "costAmount" TYPE DECIMAL(20,4); -- contract: F-116-q

ALTER TABLE "engagement"."spin_wheel_config"
  ALTER COLUMN "dailyBudgetCapAmount" TYPE DECIMAL(20,4), -- contract: F-116-q
  ALTER COLUMN "requiresMinTotalPurchaseAmount" TYPE DECIMAL(20,4); -- contract: F-116-q

ALTER TABLE "engagement"."spin_wheel_day"
  ALTER COLUMN "costSpent" TYPE DECIMAL(20,4); -- contract: F-116-q

ALTER TABLE "engagement"."spin_wheel_prize"
  ALTER COLUMN "costAmount" TYPE DECIMAL(20,4), -- contract: F-116-q
  ALTER COLUMN "prizeValue" TYPE DECIMAL(20,4); -- contract: F-116-q

ALTER TABLE "entitlement"."grant_deletion"
  ALTER COLUMN "refundedAmount" TYPE DECIMAL(20,4); -- contract: F-116-q

ALTER TABLE "network"."panel_cost"
  ALTER COLUMN "monthlyCostUsd" TYPE DECIMAL(20,4); -- contract: F-116-q

ALTER TABLE "tenant"."package_product"
  ALTER COLUMN "unitPrice" TYPE DECIMAL(20,4); -- contract: F-116-q

ALTER TABLE "tenant"."package_quota_overage"
  ALTER COLUMN "unitPrice" TYPE DECIMAL(20,4); -- contract: F-116-q

ALTER TABLE "tenant"."quota_overage_setting"
  ALTER COLUMN "unitPrice" TYPE DECIMAL(20,4); -- contract: F-116-q

ALTER TABLE "tenant"."reseller_overage_cap"
  ALTER COLUMN "amount" TYPE DECIMAL(20,4); -- contract: F-116-q

ALTER TABLE "tenant"."reseller_quota_overage"
  ALTER COLUMN "unitPrice" TYPE DECIMAL(20,4); -- contract: F-116-q

ALTER TABLE "tenant"."reseller_quota_terms_lock"
  ALTER COLUMN "unitPrice" TYPE DECIMAL(20,4); -- contract: F-116-q

ALTER TABLE "tenant"."reseller_quota_usage"
  ALTER COLUMN "overageAmount" TYPE DECIMAL(20,4), -- contract: F-116-q
  ALTER COLUMN "unitPrice" TYPE DECIMAL(20,4); -- contract: F-116-q

ALTER TABLE "tenant"."tenant_billing_transaction"
  ALTER COLUMN "amount" TYPE DECIMAL(20,4), -- contract: F-116-q
  ALTER COLUMN "balanceAfter" TYPE DECIMAL(20,4), -- contract: F-116-q
  ALTER COLUMN "sourceAmount" TYPE DECIMAL(20,4); -- contract: F-116-q

ALTER TABLE "tenant"."tenant_billing_wallet"
  ALTER COLUMN "cachedBalance" TYPE DECIMAL(20,4); -- contract: F-116-q

ALTER TABLE "tenant"."tenant_feature_package"
  ALTER COLUMN "monthlyPrice" TYPE DECIMAL(20,4), -- contract: F-116-q
  ALTER COLUMN "yearlyPrice" TYPE DECIMAL(20,4); -- contract: F-116-q

ALTER TABLE "tenant"."tenant_gateway_config"
  ALTER COLUMN "feeCeiling" TYPE DECIMAL(20,4), -- contract: F-116-q
  ALTER COLUMN "feeFloor" TYPE DECIMAL(20,4), -- contract: F-116-q
  ALTER COLUMN "maxAcceptAmount" TYPE DECIMAL(20,4), -- contract: F-116-q
  ALTER COLUMN "minAcceptAmount" TYPE DECIMAL(20,4); -- contract: F-116-q

DO $$
DECLARE v record;
BEGIN
  FOR v IN SELECT name, definition FROM money_scale_views LOOP
    EXECUTE format('CREATE VIEW ai.%I WITH (security_barrier = true) AS %s', v.name, v.definition);
    EXECUTE format('GRANT SELECT ON ai.%I TO txnet_ai_reader', v.name);
  END LOOP;
END $$;

DROP TABLE money_scale_views; -- contract: F-116-q (this migration's own temp table)

CREATE CONSTRAINT TRIGGER wallet_matches_holds AFTER UPDATE OF "heldAmount", "currencyCode" ON billing.wallet
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION billing.wallet_held_matches_holds();

-- A currency finer than the columns would be rounded by Postgres on every write:
-- refused at registration, whoever registers it.
ALTER TABLE "currency"."currency"
  ADD CONSTRAINT "currency_decimal_places_fit_money" CHECK ("decimalPlaces" BETWEEN 0 AND 4);
