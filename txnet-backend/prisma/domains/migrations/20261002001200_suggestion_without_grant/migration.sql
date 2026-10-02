-- F-038-g5: an AI suggestion about no service — `checkout_help` after a failed
-- top-up (F-038-m), a reseller's own (F-038-o) — is claimed and held on the
-- notice ledger with no Grant. Every existing row keeps its Grant: the column
-- only stops being required, and only a suggestion may leave it empty.

ALTER TABLE "notification"."retention_notice" ALTER COLUMN "grantId" DROP NOT NULL;

ALTER TABLE "notification"."retention_notice"
  ADD CONSTRAINT "retention_notice_grant_unless_suggestion" CHECK ("grantId" IS NOT NULL OR "notice" = 'ai.suggestion');

-- The (grantId, notice, period) key treats NULLs as distinct, so a grantless
-- suggestion is kept once per action here — the claim's `skipDuplicates` relies on it.
CREATE UNIQUE INDEX "retention_notice_grantless_key" ON "notification"."retention_notice" ("notice", "period") WHERE "grantId" IS NULL;
