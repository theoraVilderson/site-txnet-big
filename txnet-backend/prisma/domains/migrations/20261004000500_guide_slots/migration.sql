-- F-414-h — guide slots (ADR-0116 point 2). The registry is shared-core's
-- guide-slots.ts; the writer refuses a placement it does not hold. The database
-- holds what it can see alone: a ref is a slug or a lower-case UUID (no URL, no
-- callback data), and a panel route shows on the panel, a bot screen in the bot.
--
-- Tightens two CHECKs on a table that held no rows (dev, 2026-10-04).
-- Rollback: drop both constraints, restore "guide_placement_ref" (length 1-200).

ALTER TABLE "guide"."guide_placement"
  DROP CONSTRAINT "guide_placement_ref",
  ADD CONSTRAINT "guide_placement_ref" CHECK ("targetRef" ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  ADD CONSTRAINT "guide_placement_slot" CHECK (
    ("targetKind" = 'route' AND "surface" = 'panel')
    OR ("targetKind" = 'bot_screen' AND "surface" = 'bot')
    OR "targetKind" IN ('product', 'os', 'app')
  );
