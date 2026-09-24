-- F-027-bl — a panel group places one config on every non-drain healthy member
-- (catalog §7.3, `mirror`).
--
-- 1. `panel_group.protocol`: a config needs one, and neither the group nor the
--    variant named it (user 2026-09-24: the group). One per member panel; a
--    list later keys (group, panel, protocol) without a rebuild.
-- 2. `config_group_panel_once`: a Grant's placement is one row per panel. The
--    fulfilment sweep is at-least-once, so two runs can both read a panel as
--    uncovered; the second insert is refused here and its transaction rolls
--    back whole, never leaving two clients on one panel. Partial on
--    `credentialGroupId`, so a Grant with no group (a manual provision, a
--    move) is not held to it.
--
-- Additive. No group exists on dev and no config carries `credentialGroupId`,
-- so neither validates against anything. Rollback: drop the index and the column.

-- AlterTable
ALTER TABLE "network"."panel_group" ADD COLUMN "protocol" "network"."ConfigProtocol" NOT NULL DEFAULT 'vless';

-- CreateIndex
CREATE UNIQUE INDEX "config_group_panel_once" ON "network"."config"("grantId", "panelId") WHERE "credentialGroupId" IS NOT NULL;
