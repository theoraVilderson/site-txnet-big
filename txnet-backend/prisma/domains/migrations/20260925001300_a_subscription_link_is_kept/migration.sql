-- F-114-e-a (D-43, ADR-0085): the subscription token is kept sealed beside its
-- hash, so My services can show the same `/sub` link as often as it is asked.
-- `/sub` still finds a Grant by `subscriptionTokenHash` alone.
--
-- Existing Grants get NULL: only their hash was ever stored, so their token
-- cannot be recovered. Their user resets the link once. Rotating them all here
-- would have broken every link already in a user's app.
--
-- Rollback: drop the constraint and the column; nothing else reads them.

ALTER TABLE "entitlement"."grant"
  ADD COLUMN "subscriptionTokenSealed" JSONB;

ALTER TABLE "entitlement"."grant"
  ADD CONSTRAINT "grant_token_sealed_shape" CHECK (
    "subscriptionTokenSealed" IS NULL
    OR (jsonb_typeof("subscriptionTokenSealed") = 'object'
        AND "subscriptionTokenSealed" ?& ARRAY['kekId', 'iv', 'authTag', 'ciphertext'])
  );
