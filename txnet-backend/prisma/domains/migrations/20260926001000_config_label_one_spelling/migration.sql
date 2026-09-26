-- F-307-o — a config's label in one spelling (user 2026-09-26): ي/ى -> ی,
-- ك -> ک, Persian and Arabic digits -> Latin. billing folds a label as it
-- saves it (`billing-service/src/app/traffic/config-text.ts`); this folds the
-- labels saved before, so the grant list's `q` finds them either way.
--
-- Rewrites the text of labels holding one of those characters, nothing else:
-- the same word, spelled the way a new save spells it. No schema change.
-- Not reversible (the original spelling is not kept); nothing reads it.

UPDATE "network"."config"
SET "userLabel" = translate("userLabel", 'يىك۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩', 'ییک01234567890123456789')
WHERE "userLabel" ~ '[يىك۰-۹٠-٩]';
