-- F-019-v6 (ADR-0107 points 3, 8, 10, 11; user 2026-10-01): a package sells a
-- platform product by quota. Each listing (F-019-v5's package_product) states
-- the sales it includes per fixed day, week and month — each optional, null =
-- no bound in that window — counted over all of the reseller's sales of the
-- product, and what happens past any of them: `stop`, or `overage` at one
-- unit price in the platform's currency, charged once per sale however many
-- windows it is past.
--
-- The quota engine counts a product as meter `product:<productId>`; a period
-- lock (F-019-v3) keeps one row per window, key `product:<productId>:<day|week|month>`,
-- so reseller_quota_terms_lock's key shape widens to the usage meter's.
--
-- Additive; rollback: ALTER TABLE "tenant"."package_product" DROP COLUMN
-- "dayIncluded", DROP COLUMN "weekIncluded", DROP COLUMN "monthIncluded",
-- DROP COLUMN "mode", DROP COLUMN "unitPrice", DROP COLUMN "currencyCode";
-- restore reseller_quota_terms_lock_key_shape to '^[a-z][a-z0-9_]{0,63}$'
-- (after deleting the product: rows).

ALTER TABLE "tenant"."package_product"
  ADD COLUMN "dayIncluded" INTEGER,
  ADD COLUMN "weekIncluded" INTEGER,
  ADD COLUMN "monthIncluded" INTEGER,
  ADD COLUMN "mode" "tenant"."QuotaOverageMode" NOT NULL DEFAULT 'stop',
  ADD COLUMN "unitPrice" DECIMAL(18,2),
  ADD COLUMN "currencyCode" TEXT,
  ADD CONSTRAINT "package_product_included_not_negative" CHECK (
        ("dayIncluded" IS NULL OR "dayIncluded" >= 0)
    AND ("weekIncluded" IS NULL OR "weekIncluded" >= 0)
    AND ("monthIncluded" IS NULL OR "monthIncluded" >= 0)),
  ADD CONSTRAINT "package_product_priced_iff_overage" CHECK (
        ("mode" = 'stop' AND "unitPrice" IS NULL AND "currencyCode" IS NULL)
     OR ("mode" = 'overage' AND "unitPrice" > 0 AND "currencyCode" ~ '^[A-Z]{3}$'));

ALTER TABLE "tenant"."reseller_quota_terms_lock"
  DROP CONSTRAINT "reseller_quota_terms_lock_key_shape",
  ADD CONSTRAINT "reseller_quota_terms_lock_key_shape" CHECK ("key" ~ '^[a-z][a-z0-9_.:-]{0,127}$');
