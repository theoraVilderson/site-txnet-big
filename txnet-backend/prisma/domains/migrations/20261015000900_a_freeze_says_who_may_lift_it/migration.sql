-- F-0401-a — a frozen Grant says how it was frozen and whether its clock
-- stopped, both fixed at the freeze (entitlement `contract.admin.md` "Freeze").
--
-- 1. `FreezeMode` (`hard` / `soft` / `self`) and `grant.freezeMode`: who may
--    lift it. Hard beats soft beats self; the user lifts only soft or self.
-- 2. `grant.freezeStopsClock`: the unfreeze moves `endsAt` only when it did.
--
-- Additive. Every freeze already in place was an admin's, clock stopped, so it
-- is backfilled `hard` + `true` and behaves as before. Trigger
-- `grant_freeze_mode_is_frozen` clears both whenever the Grant is not a
-- suspended `admin_frozen` one (as `grant_awaiting_panel_is_frozen` does), and
-- gives a freeze written without them today's meaning — so code from before
-- this row keeps working while it rolls out. Rollback: drop the trigger, its
-- function, the CHECK, the two columns and the enum.

CREATE TYPE "entitlement"."FreezeMode" AS ENUM ('hard', 'soft', 'self');

ALTER TABLE "entitlement"."grant"
  ADD COLUMN "freezeMode" "entitlement"."FreezeMode",
  ADD COLUMN "freezeStopsClock" BOOLEAN;

UPDATE "entitlement"."grant"
   SET "freezeMode" = 'hard', "freezeStopsClock" = true
 WHERE "status" = 'suspended' AND "statusReason" = 'admin_frozen';

CREATE FUNCTION entitlement.grant_freeze_mode_is_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" <> 'suspended' OR NEW."statusReason" IS DISTINCT FROM 'admin_frozen' THEN
    NEW."freezeMode" := NULL;
    NEW."freezeStopsClock" := NULL;
  ELSE
    NEW."freezeMode" := COALESCE(NEW."freezeMode", 'hard');
    NEW."freezeStopsClock" := COALESCE(NEW."freezeStopsClock", true);
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER grant_freeze_mode_is_frozen
  BEFORE INSERT OR UPDATE ON "entitlement"."grant"
  FOR EACH ROW EXECUTE FUNCTION entitlement.grant_freeze_mode_is_frozen();

ALTER TABLE "entitlement"."grant"
  ADD CONSTRAINT "grant_freeze_mode_is_frozen" CHECK (
      ("status" = 'suspended' AND "statusReason" IS NOT DISTINCT FROM 'admin_frozen')
      = ("freezeMode" IS NOT NULL AND "freezeStopsClock" IS NOT NULL));
