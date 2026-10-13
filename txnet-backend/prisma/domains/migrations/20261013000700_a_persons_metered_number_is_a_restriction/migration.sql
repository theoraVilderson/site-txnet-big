-- F-030-e: one person's own number of open metered services (F-118-ao's
-- `user_grant_limit`) becomes the `metered_services_max` restriction
-- (governance F-030-d), so a cap on one person lives in one place. The
-- tenant's default (`grant_limit_setting`) and the reseller's ceiling
-- (`user_metered_cap_max`) are unchanged.
--
-- Rows are copied first: the number (bounded by the key's max, 1000, which
-- the old route already held), the reason (required now: a blank one gets a
-- line saying where it came from), who set it and when. Then the old table is
-- dropped. Destructive (DROP TABLE): asked and approved (user, 2026-10-13);
-- 0 rows on dev. Rollback: recreate the table from
-- 20260930000700_a_user_holds_few_metered_grants and copy the rows back.

INSERT INTO "governance"."user_restriction" ("userId", "tenantId", "key", "value", "reason", "setByUserId", "expiresAt", "createdAt", "updatedAt")
SELECT
  "userId",
  "tenantId",
  'metered_services_max',
  to_jsonb(LEAST("meteredOpenCap", 1000)),
  COALESCE(NULLIF(btrim(left("reason", 500)), ''), 'Moved from the metered cap (F-030-e)'),
  "setByUserId",
  NULL,
  "createdAt",
  "updatedAt"
FROM "entitlement"."user_grant_limit"
ON CONFLICT ("userId", "key") DO NOTHING;

DROP TABLE "entitlement"."user_grant_limit"; -- contract: F-030-e
