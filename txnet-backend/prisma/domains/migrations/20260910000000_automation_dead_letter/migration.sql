-- A message that ends is a message with a record (F-067-d).
--
-- `automation.dead_letter` is where the broker's dead-letter queue is drained
-- to. Until now a rejected message was destroyed: `BrokerService.consumeTicks`
-- nacked with `requeue: false` and the queue declared no dead-letter exchange.
-- That was defensible while every message was a tick — a tick recurs on the
-- next interval, and its failure is a `bot_execution_log` row. It stops being
-- defensible with the first message that does not recur, which is F-067-a (an
-- OTP send), F-067-b (a bot update) and F-067-c (an outbox event) — each of
-- which depends on this row for exactly that reason.
--
-- WHY THERE IS NO POLICY HERE
--
-- The table carries no `tenantId`, the same as the three worker tables beside
-- it: a worker is a platform-wide process, not a reseller's, and a tick's
-- tenant — when it has one — is already inside `payload`. RLS is not being
-- skipped: `20260909001500_row_level_security_all_tables` policies every table
-- **with a `tenantId` column**, and grants already cover every schema, so a
-- table without one is readable by the roles that were granted it. Adding the
-- column would have meant choosing a policy shape for a table that has no
-- tenant-scoped reader.
--
-- WHAT IS NOT HERE, ON PURPOSE
--
-- No `resolvedAt`, no re-drive. Putting a dead message back on the exchange is
-- a decision about ordering and idempotency, not a column, and it belongs to
-- its own row. This migration adds the record; reading it is
-- `GET /admin/workers/dead-letters`.
--
-- Rollback: `DROP TABLE "automation"."dead_letter"` then `DROP TYPE
-- "automation"."DeadLetterReason"`. Lossless only in the sense that what is
-- lost is the record of messages already lost — take a copy first.

-- CreateEnum
CREATE TYPE "automation"."DeadLetterReason" AS ENUM ('handler_failed', 'unparseable', 'gate_gave_up');

-- CreateTable
CREATE TABLE "automation"."dead_letter" (
    "id" UUID NOT NULL,
    "routingKey" TEXT NOT NULL,
    "workerKey" TEXT,
    "reason" "automation"."DeadLetterReason" NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "detail" TEXT NOT NULL,
    "payload" JSONB,
    "rawPayload" TEXT,
    "deadLetteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dead_letter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dead_letter_deadLetteredAt_idx" ON "automation"."dead_letter"("deadLetteredAt" DESC);

-- CreateIndex
CREATE INDEX "dead_letter_workerKey_deadLetteredAt_idx" ON "automation"."dead_letter"("workerKey", "deadLetteredAt" DESC);
