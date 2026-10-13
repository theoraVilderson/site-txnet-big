-- OPS-1-l (H13): an outbox event carries the request that wrote it, so the
-- relay can publish it as `x-request-id`. Nullable, additive only.
ALTER TABLE "automation"."outbox_event" ADD COLUMN "requestId" TEXT;
