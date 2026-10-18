-- F-116-p follow-up: Prisma reads a row's primary key with any select, so the
-- AI reader's lookup of a currency's places also reads `currency.id` — denied by
-- 20261018000100's grant of (code, decimalPlaces) alone, which failed every
-- hourly decision run since. Still reference data, no tenant's rows.
GRANT SELECT ("id") ON currency.currency TO txnet_ai_reader;
