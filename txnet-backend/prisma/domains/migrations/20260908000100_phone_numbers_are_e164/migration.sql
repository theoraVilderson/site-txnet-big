-- Phone numbers become E.164 (ADR-0018).
--
-- Until this migration the only accepted country was Iran, so every stored
-- number is an Iranian national `09xxxxxxxxx`. The rewrite is `09…` ->
-- `+989…`, which is injective, so the unique constraint on
-- "identity"."user"."phoneNumber" cannot be violated by it.
--
-- Every statement is guarded on the national shape, so a number already in
-- E.164 is untouched and the migration is safe to re-run. Numbers that match
-- neither shape are left alone deliberately: rewriting something whose
-- country nobody knows would invent data.
--
-- The Redis side of the cutover is not here and cannot be: keys built from
-- the old form are abandoned by bumping REDIS_KEYSPACE_VERSION to v2 in the
-- same deploy (ADR-0005, C-03).

UPDATE "identity"."user"
   SET "phoneNumber" = '+98' || substring("phoneNumber" from 2)
 WHERE "phoneNumber" ~ '^09[0-9]{9}$';

UPDATE "identity"."otp_code"
   SET "phoneNumber" = '+98' || substring("phoneNumber" from 2)
 WHERE "phoneNumber" ~ '^09[0-9]{9}$';

UPDATE "identity"."linked_bot_account"
   SET "phoneNumber" = '+98' || substring("phoneNumber" from 2)
 WHERE "phoneNumber" ~ '^09[0-9]{9}$';
