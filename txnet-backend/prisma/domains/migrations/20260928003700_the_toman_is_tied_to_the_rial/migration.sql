-- F-116-m: the toman (IRT) is ten rials, a currency with no rate of its own
-- (user, 2026-09-28). `readFxRate` answers it as IRR's rate / 10
-- (`DERIVED_CURRENCIES` in shared-core), so no rate row is ever written for it.
-- The row only makes it choosable where a currency is picked. Seeded here as
-- well as in `seed.js` so a database seeded before this change has it too;
-- an operator's own IRT row, if one exists, is left alone.
INSERT INTO "currency"."currency" ("id", "code", "name", "symbol", "decimalPlaces", "isBaseCurrency", "isSelectableByUser", "isActive")
VALUES (gen_random_uuid(), 'IRT', 'Iranian Toman', 'تومان', 0, false, true, true)
ON CONFLICT ("code") DO NOTHING;
