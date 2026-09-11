-- The transactional outbox ADR-0021 decided and nothing built (F-067-c).
--
-- ADR-0021 was accepted on 2026-09-09 and none of it existed: no `outbox`
-- model in `prisma/domains/`, and `worker-service` registering only
-- `worker_heartbeat` and `vault_credential_retention`. Nothing broke because
-- every producing domain (`billing`, `network`, `notification`, `ai`) is still
-- `draft` — which is also exactly why it is cheap today and expensive on the
-- day the first payment lands.
--
-- WHAT THE TABLE BUYS
--
-- A producing service inserts a row here **inside the same transaction** that
-- writes the ledger (ADR-0002), and `OutboxRelayJob` publishes the unpublished
-- ones afterwards. Without it there is a window between commit and publish in
-- which the money moved and the event vanished with no record that one was
-- owed. Delivery is at-least-once and never exactly-once: `id` is the event id
-- and travels as the AMQP `messageId`, so a consumer keys its idempotency on
-- it.
--
-- WHY THERE IS NO POLICY HERE
--
-- No `tenantId` column, the same call `dead_letter` and the three worker
-- tables make. `20260909001500_row_level_security_all_tables` policies every
-- table **with a `tenantId`**, and grants already cover every schema, so a
-- table without one is readable by the roles that were granted it. The relay
-- is a platform-wide process that must read every tenant's events, so the
-- column would have meant choosing a policy shape for a table whose only
-- reader is unscoped. Which tenant an event concerns lives in `payload`, where
-- the domain that wrote the event decides what its own event means.
--
-- THE TWO INDEXES, AND WHY THERE ARE TWO
--
-- `outbox_event_publishedAt_occurredAt_idx` is Prisma's, kept in step by the
-- schema. `outbox_event_unpublished_idx` is partial — `WHERE "publishedAt" IS
-- NULL` — which Prisma cannot express, and it is the one the relay actually
-- uses. The difference matters over time rather than today: published rows
-- accumulate for ever and unpublished ones are a working set of near zero, so
-- the partial index stays the size of the backlog instead of the size of the
-- history. Section 99, the same pattern `20260909000200_bot_integration` uses.
--
-- WHAT IS NOT HERE, ON PURPOSE
--
-- No retention or archive of published rows. ADR-0021 calls the table an audit
-- trail of what the system decided to announce, and deciding when that stops
-- being worth keeping needs a first producer to have opinions about — it is a
-- row of its own, the way `vault_credential_retention` was for the vault.
--
-- Rollback: `DROP TABLE "automation"."outbox_event"`. Lossless only if nothing
-- has been written; a row that is still unpublished is an event a committed
-- transaction promised to announce.

-- CreateTable
CREATE TABLE "automation"."outbox_event" (
    "id" UUID NOT NULL,
    "aggregate" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,

    CONSTRAINT "outbox_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "outbox_event_publishedAt_occurredAt_idx" ON "automation"."outbox_event"("publishedAt", "occurredAt");

-- Section 99 — hand-written, not expressible in Prisma.
-- The relay's own index: it only ever reads unpublished rows, in `occurredAt`
-- order, under FOR UPDATE SKIP LOCKED.
CREATE INDEX "outbox_event_unpublished_idx"
    ON "automation"."outbox_event" ("occurredAt")
    WHERE "publishedAt" IS NULL;
