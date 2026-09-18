-- F-061-g — a bot's switch scope names the bot's tenant (ADR-0015, as amended).
--
-- `bot:<platform>:<chatId>` becomes `bot:<tenantId>:<platform>:<chatId>`. A
-- Telegram/Bale private chat id is the person's own id, the same with every
-- bot, so a reseller's owner (ADR-0059) found the group and acting-as pointer
-- they built with the platform's bot inside their reseller's Mini App.
--
-- Until now a bot scope only ever held accounts of that bot's tenant — every
-- proof ran in it and nothing admitted another tenant's account there — so the
-- member's own tenant is the bot's. `device:` keys are untouched: the browser
-- cookie is host-only already. Old keys have two colons and new ones three,
-- which makes this idempotent.
--
-- A live session's Redis marker keeps the old key until its next refresh
-- re-mints it from the row; until then its switcher reads empty.
--
-- Rollback: strip the second segment,
--   SET "scopeKey" = 'bot:' || split_part("scopeKey", ':', 3) || ':' || split_part("scopeKey", ':', 4)
--   WHERE "scopeKey" LIKE 'bot:%:%:%'.

UPDATE "audit"."linked_account_member" AS m
SET "scopeKey" = 'bot:' || u."tenantId" || substr(m."scopeKey", 4)
FROM "identity"."user" AS u
WHERE u."id" = m."userId"
  AND m."scopeKey" LIKE 'bot:%'
  AND m."scopeKey" NOT LIKE 'bot:%:%:%';

UPDATE "identity"."session" AS s
SET "scopeKey" = 'bot:' || u."tenantId" || substr(s."scopeKey", 4)
FROM "identity"."user" AS u
WHERE u."id" = s."userId"
  AND s."scopeKey" LIKE 'bot:%'
  AND s."scopeKey" NOT LIKE 'bot:%:%:%';
