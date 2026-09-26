-- F-027-cg (ADR-0090 decision 2, D-48): a selling setting resolves group
-- membership -> panel -> platform default. Null at a layer is "not set here";
-- the platform default (billing-service `PLATFORM_SELLING_DEFAULTS`: `all`,
-- no cap, priority 0, weight 1) always answers, so every setting resolves.
-- Server facts (addresses, credentials, `maxRequestsPerMinute`,
-- `maxLineRateBps`) stay panel-only and get no member column.
--
-- No effective value changes:
--  - `panel.inboundPlacement` keeps every row's value; only new panels start
--    unset (= the platform's `all`). `panel.maxClients` null already meant no
--    cap, which is the platform default.
--  - `panel_group_member.priority` / `weight` were never sent by any client,
--    so every row holds the old column default, equal to the platform
--    default; they are cleared to "not set" so a panel's own value reaches
--    them. A value that differs from the default is kept as the member's.

ALTER TABLE "network"."panel"
  ALTER COLUMN "inboundPlacement" DROP NOT NULL,
  ALTER COLUMN "inboundPlacement" DROP DEFAULT,
  ADD COLUMN "priority" INTEGER,
  ADD COLUMN "weight" INTEGER,
  ADD CONSTRAINT "panel_priority_non_negative" CHECK ("priority" IS NULL OR "priority" >= 0),
  ADD CONSTRAINT "panel_weight_positive" CHECK ("weight" IS NULL OR "weight" >= 1);

ALTER TABLE "network"."panel_group_member"
  ALTER COLUMN "priority" DROP NOT NULL,
  ALTER COLUMN "priority" DROP DEFAULT,
  ALTER COLUMN "weight" DROP NOT NULL,
  ALTER COLUMN "weight" DROP DEFAULT,
  ADD COLUMN "inboundPlacement" "network"."InboundPlacement",
  ADD COLUMN "maxClients" INTEGER,
  ADD CONSTRAINT "panel_group_member_max_clients_positive" CHECK ("maxClients" IS NULL OR "maxClients" >= 1);

UPDATE "network"."panel_group_member" SET "priority" = NULL WHERE "priority" = 0;
UPDATE "network"."panel_group_member" SET "weight" = NULL WHERE "weight" = 1;
