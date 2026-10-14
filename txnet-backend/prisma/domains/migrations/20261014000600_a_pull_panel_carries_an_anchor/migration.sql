-- F-027-ew — a pull panel carries an anchor (ADR-0130 decisions 1 and 3,
-- D-67). Our clients on a server are the only proof of which server it is,
-- and that proof is missing exactly when it holds none of them: an empty,
-- reinstalled or foreign server behind a re-pointed address. The anchor is
-- one disabled client (1-byte limit, no expiry) the connection test plants —
-- or the first pass, for a panel accepted before this — and the panel row
-- keeps its tag, uuid and the id the panel gave it.
--
-- Tag and uuid are unique: an anchor names one panel. The three are set
-- together or not at all, and only on a pull panel — a push panel is never
-- listed, so it has nowhere to carry one.
--
-- Additive: three nullable columns, two unique indexes over values nothing
-- holds yet, two CHECKs every existing row (all null) passes.

ALTER TABLE "network"."panel"
  ADD COLUMN "anchorTag" TEXT,
  ADD COLUMN "anchorUuid" TEXT,
  ADD COLUMN "anchorRemoteId" TEXT;

CREATE UNIQUE INDEX "panel_anchorTag_key" ON "network"."panel"("anchorTag");
CREATE UNIQUE INDEX "panel_anchorUuid_key" ON "network"."panel"("anchorUuid");

ALTER TABLE "network"."panel"
  ADD CONSTRAINT "panel_anchor_is_whole" CHECK (
    ("anchorTag" IS NULL) = ("anchorUuid" IS NULL)
    AND ("anchorTag" IS NULL) = ("anchorRemoteId" IS NULL)),
  ADD CONSTRAINT "panel_anchor_is_pull_only" CHECK (
    "anchorTag" IS NULL OR "transport" = 'pull');
