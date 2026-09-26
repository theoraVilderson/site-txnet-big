-- F-027-ce — the connection test refuses a panel that is one already
-- registered under another address (ADR-0090 decision 1, D-48), and names it.
--
-- `duplicateOfPanelId` is set by `network-service` with `reviewState =
-- 'refused'` and only then (CHECK below); billing's address edit and restore,
-- which send a panel back to `pending`, clear it. Deleting the named panel
-- leaves the refusal standing without a name (SET NULL).
--
-- Additive: a nullable column no row sets yet.

ALTER TABLE "network"."panel" ADD COLUMN "duplicateOfPanelId" UUID;

ALTER TABLE "network"."panel"
  ADD CONSTRAINT "panel_duplicateOfPanelId_fkey" FOREIGN KEY ("duplicateOfPanelId")
    REFERENCES "network"."panel"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "panel_duplicate_is_refused"
    CHECK ("duplicateOfPanelId" IS NULL OR "reviewState" = 'refused'),
  ADD CONSTRAINT "panel_duplicate_is_another"
    CHECK ("duplicateOfPanelId" IS DISTINCT FROM "id");
