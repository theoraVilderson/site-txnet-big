-- F-027-cf — a `foreign_claim` event names both panels: `panelId`, the one
-- that answered with clients not its own, and `foreignPanelId`, the one whose
-- configs those clients are (ADR-0090 decision 1).
--
-- Set by `network-service` on a `foreign_claim` and on no other type (CHECK).
-- Deleting the named panel leaves the event standing without the name
-- (SET NULL), as `panel.duplicateOfPanelId` does.
--
-- Additive: a nullable column no row sets yet. Rollback: drop the column.

ALTER TABLE "network"."panel_drift_event" ADD COLUMN "foreignPanelId" UUID;

ALTER TABLE "network"."panel_drift_event"
  ADD CONSTRAINT "panel_drift_event_foreignPanelId_fkey" FOREIGN KEY ("foreignPanelId")
    REFERENCES "network"."panel"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "panel_drift_event_foreign_is_claim"
    CHECK ("foreignPanelId" IS NULL OR "eventType" = 'foreign_claim'),
  ADD CONSTRAINT "panel_drift_event_foreign_is_another"
    CHECK ("foreignPanelId" IS DISTINCT FROM "panelId");
