-- F-111-d: the delivery clock of a paid Grant (spec §5.8 step 3). A purchase
-- is issued `pending`; the `grant_delivery` sweep checks it when
-- `nextDeliveryAt` is due (null = at once), and each check that finds it not
-- yet delivered counts one attempt and pushes the next one out. Past the last
-- attempt the Grant is cancelled and its invoice refunded.
--
-- Rollback: drop the index and the two columns; nothing else reads them.

ALTER TABLE "entitlement"."grant"
  ADD COLUMN "deliveryAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nextDeliveryAt" TIMESTAMP(3);

ALTER TABLE "entitlement"."grant"
  ADD CONSTRAINT "grant_delivery_attempts_not_negative" CHECK ("deliveryAttempts" >= 0);

CREATE INDEX "grant_status_nextDeliveryAt_idx" ON "entitlement"."grant" ("status", "nextDeliveryAt");
