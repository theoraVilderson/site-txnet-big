-- F-201-g (D-63): one user's import from an old subscription link, on the
-- whole-panel engine. A link run names the person it is for and the prepaid
-- product the link becomes (no inbounds to map); its one item keeps the
-- admin's corrections beside what the link said, never over it.
-- Additive: no row is rewritten — no link run exists before this.

ALTER TABLE "entitlement"."migration_run"
    ADD COLUMN "userId" UUID,
    ADD COLUMN "variantId" UUID;

ALTER TABLE "entitlement"."migration_run"
    ADD CONSTRAINT "migration_run_link_names_its_person" CHECK (("kind" = 'link') = ("userId" IS NOT NULL)),
    ADD CONSTRAINT "migration_run_variant_only_on_link" CHECK ("variantId" IS NULL OR "kind" = 'link');

ALTER TABLE "entitlement"."migration_item"
    ADD COLUMN "correctedDataLimitBytes" BIGINT,
    ADD COLUMN "correctedUsedBytes" BIGINT,
    ADD COLUMN "correctedExpiresAt" TIMESTAMP(3);

ALTER TABLE "entitlement"."migration_item"
    ADD CONSTRAINT "migration_item_correction_not_negative" CHECK (
        ("correctedDataLimitBytes" IS NULL OR "correctedDataLimitBytes" >= 0)
        AND ("correctedUsedBytes" IS NULL OR "correctedUsedBytes" >= 0));
