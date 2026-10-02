-- TZ-1-f (ADR-0108 point 6): a notification preference's zone may be null,
-- meaning the user's resolved zone (user -> browser -> tenant -> platform).
-- Additive: every existing row keeps the zone it was saved with.
ALTER TABLE "notification"."notification_preference"
  ALTER COLUMN "timezone" DROP NOT NULL,
  ALTER COLUMN "timezone" DROP DEFAULT;
