-- F-033-a (ADR-0112): support is one Conversation.
--
-- 1. **The ticket/chat tables are dropped**, not migrated: no service ever
--    wrote them, and the drop asserts that rather than assuming it (a dropped
--    table cannot be undone by the next migration). Catalog §11.1: tickets and
--    live chat are one thread whose `mode` varies, never two record types.
-- 2. **`impersonation_session.linkedTicketId` becomes `linkedConversationId`**
--    (empty everywhere; asserted below too).
-- 3. **`ai.reader_open_ticket` keeps its name and columns** and reads
--    `conversation`, which carries `tenantId` itself — no join to `identity`.
--    F-1506's quiet-down code does not change.
-- 4. **`message` is monthly range-partitioned on `createdAt`**, with the
--    `(id, createdAt)` key Postgres requires (F-027-e's shape). No `DEFAULT`
--    partition: a month nobody created is an insert error, and
--    `support.ensure_message_partition` — `SECURITY DEFINER`, granted to
--    `txnet_app`, policying what it creates (F-027-ak) — is what the service
--    calls on that error. Six months are made here by the same function.
-- 5. **RLS on every table.** Categories are shared-read: a NULL `tenantId` is
--    the platform's default set, readable by every tenant and writable by none.
-- 6. **The default categories are seeded** with a name in every `Language`.
--
-- Rollback: drop the six tables, the function and the enums; recreate the
-- five tables, `linkedTicketId` and the view as 20260908000000_init and
-- 20261002000600 declare them. The rollback expires with the first row.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM support.ticket) OR EXISTS (SELECT 1 FROM support.chat_session)
     OR EXISTS (SELECT 1 FROM support.ticket_message) OR EXISTS (SELECT 1 FROM support.chat_message)
     OR EXISTS (SELECT 1 FROM support.ticket_attachment) THEN
    RAISE EXCEPTION 'support ticket/chat tables have rows; F-033-a drops them and cannot carry them over';
  END IF;
  IF EXISTS (SELECT 1 FROM audit.impersonation_session WHERE "linkedTicketId" IS NOT NULL) THEN
    RAISE EXCEPTION 'audit.impersonation_session cites tickets; F-033-a cannot re-point them';
  END IF;
END
$$;

-- The quiet-down view reads support.ticket; it is rebuilt on conversation below.
DROP VIEW ai.reader_open_ticket;

-- CreateEnum
CREATE TYPE "support"."ConversationStatus" AS ENUM ('open', 'pending_user', 'pending_agent', 'resolved', 'closed');

-- CreateEnum
CREATE TYPE "support"."ConversationMode" AS ENUM ('live', 'async');

-- CreateEnum
CREATE TYPE "support"."ConversationPriority" AS ENUM ('low', 'normal', 'high', 'urgent');

-- CreateEnum
CREATE TYPE "support"."MessageSenderKind" AS ENUM ('user', 'agent', 'system', 'bot', 'ai');

-- CreateEnum
CREATE TYPE "support"."AttachmentScanStatus" AS ENUM ('pending', 'clean', 'infected', 'failed');

-- DropForeignKey
ALTER TABLE "audit"."impersonation_session" DROP CONSTRAINT "impersonation_session_linkedTicketId_fkey";

-- DropForeignKey
ALTER TABLE "support"."ticket_message" DROP CONSTRAINT "ticket_message_ticketId_fkey";

-- DropForeignKey
ALTER TABLE "support"."ticket_attachment" DROP CONSTRAINT "ticket_attachment_ticketMessageId_fkey";

-- DropForeignKey
ALTER TABLE "support"."chat_message" DROP CONSTRAINT "chat_message_chatSessionId_fkey";

-- AlterTable
ALTER TABLE "audit"."impersonation_session" DROP COLUMN "linkedTicketId",
ADD COLUMN     "linkedConversationId" UUID;

-- DropTable
DROP TABLE "support"."ticket";

-- DropTable
DROP TABLE "support"."ticket_message";

-- DropTable
DROP TABLE "support"."ticket_attachment";

-- DropTable
DROP TABLE "support"."chat_session";

-- DropTable
DROP TABLE "support"."chat_message";

-- DropEnum
DROP TYPE "support"."TicketStatus";

-- DropEnum
DROP TYPE "support"."TicketPriority";

-- DropEnum
DROP TYPE "support"."SenderType";

-- DropEnum
DROP TYPE "support"."ChatSessionStatus";

-- CreateTable
CREATE TABLE "support"."support_category" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "key" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support"."support_category_text" (
    "categoryId" UUID NOT NULL,
    "tenantId" UUID,
    "lang" "identity"."Language" NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "support_category_text_pkey" PRIMARY KEY ("categoryId","lang")
);

-- CreateTable
CREATE TABLE "support"."conversation" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "resellerPath" TEXT,
    "userId" UUID NOT NULL,
    "subject" TEXT NOT NULL,
    "categoryId" UUID,
    "status" "support"."ConversationStatus" NOT NULL DEFAULT 'open',
    "mode" "support"."ConversationMode" NOT NULL DEFAULT 'async',
    "priority" "support"."ConversationPriority" NOT NULL DEFAULT 'normal',
    "assignedToUserId" UUID,
    "lastSeq" INTEGER NOT NULL DEFAULT 0,
    "firstResponseAt" TIMESTAMP(3),
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "ratingScore" SMALLINT,
    "aiTriageLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support"."message" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "senderKind" "support"."MessageSenderKind" NOT NULL,
    "senderUserId" UUID,
    "body" TEXT NOT NULL,
    "internal" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "message_pkey" PRIMARY KEY ("id","createdAt")
) PARTITION BY RANGE ("createdAt");

-- CreateTable
CREATE TABLE "support"."conversation_read" (
    "conversationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "lastReadSeq" INTEGER NOT NULL DEFAULT 0,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_read_pkey" PRIMARY KEY ("conversationId","userId")
);

-- CreateTable
CREATE TABLE "support"."message_attachment" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "messageCreatedAt" TIMESTAMP(3) NOT NULL,
    "objectKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "scanStatus" "support"."AttachmentScanStatus" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_attachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "support_category_tenantId_key_key" ON "support"."support_category"("tenantId", "key");

-- CreateIndex
CREATE INDEX "conversation_tenantId_userId_lastMessageAt_idx" ON "support"."conversation"("tenantId", "userId", "lastMessageAt" DESC);

-- CreateIndex
CREATE INDEX "conversation_tenantId_status_priority_lastMessageAt_idx" ON "support"."conversation"("tenantId", "status", "priority", "lastMessageAt");

-- CreateIndex
CREATE INDEX "message_conversationId_seq_idx" ON "support"."message"("conversationId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "message_attachment_objectKey_key" ON "support"."message_attachment"("objectKey");

-- CreateIndex
CREATE INDEX "message_attachment_conversationId_idx" ON "support"."message_attachment"("conversationId");

-- CreateIndex
CREATE INDEX "message_attachment_messageId_messageCreatedAt_idx" ON "support"."message_attachment"("messageId", "messageCreatedAt");

-- AddForeignKey
ALTER TABLE "audit"."impersonation_session" ADD CONSTRAINT "impersonation_session_linkedConversationId_fkey" FOREIGN KEY ("linkedConversationId") REFERENCES "support"."conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support"."support_category_text" ADD CONSTRAINT "support_category_text_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "support"."support_category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support"."conversation" ADD CONSTRAINT "conversation_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "support"."support_category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support"."message" ADD CONSTRAINT "message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "support"."conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support"."conversation_read" ADD CONSTRAINT "conversation_read_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "support"."conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support"."message_attachment" ADD CONSTRAINT "message_attachment_messageId_messageCreatedAt_fkey" FOREIGN KEY ("messageId", "messageCreatedAt") REFERENCES "support"."message"("id", "createdAt") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support"."message_attachment" ADD CONSTRAINT "message_attachment_objectKey_fkey" FOREIGN KEY ("objectKey") REFERENCES "storage"."stored_object"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- Row-Level Security
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'support.conversation',
    'support.message',
    'support.conversation_read',
    'support.message_attachment'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO txnet_app, txnet_cross_tenant', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %s
        AS PERMISSIVE FOR ALL TO txnet_app
        USING ("tenantId" = public.current_tenant_id())
        WITH CHECK ("tenantId" = public.current_tenant_id())
    $p$, t);
    EXECUTE format($p$
      CREATE POLICY cross_tenant ON %s
        AS PERMISSIVE FOR ALL TO txnet_cross_tenant
        USING (true) WITH CHECK (true)
    $p$, t);
  END LOOP;

  -- Shared-read: the platform's defaults (NULL) and the tenant's own.
  FOREACH t IN ARRAY ARRAY[
    'support.support_category',
    'support.support_category_text'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO txnet_app, txnet_cross_tenant', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %s
        AS PERMISSIVE FOR ALL TO txnet_app
        USING ("tenantId" IS NULL OR "tenantId" = public.current_tenant_id())
        WITH CHECK ("tenantId" = public.current_tenant_id())
    $p$, t);
    EXECUTE format($p$
      CREATE POLICY cross_tenant ON %s
        AS PERMISSIVE FOR ALL TO txnet_cross_tenant
        USING (true) WITH CHECK (true)
    $p$, t);
  END LOOP;
END
$$;

-- -----------------------------------------------------------------------------
-- Message partitions
-- -----------------------------------------------------------------------------
-- Idempotent, and it re-policies a partition it finds, so a call over an
-- existing month repairs rather than skips (F-027-ak's rule).
CREATE OR REPLACE FUNCTION "support"."ensure_message_partition"(a_month DATE)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = support, public, pg_temp
AS $$
DECLARE
  v_from DATE := date_trunc('month', a_month)::date;
  v_to   DATE := (date_trunc('month', a_month) + INTERVAL '1 month')::date;
  v_name TEXT := 'message_' || to_char(v_from, 'YYYY_MM');
  v_full TEXT := format('%I.%I', 'support', v_name);
BEGIN
  IF to_regclass('support.' || quote_ident(v_name)) IS NULL THEN
    EXECUTE format(
      'CREATE TABLE %I.%I PARTITION OF %I.%I FOR VALUES FROM (%L) TO (%L)',
      'support', v_name, 'support', 'message', v_from, v_to);
  END IF;

  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', v_full);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', v_full);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO txnet_app, txnet_cross_tenant', v_full);

  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', v_full);
  EXECUTE format($p$
    CREATE POLICY tenant_isolation ON %s
      AS PERMISSIVE FOR ALL TO txnet_app
      USING ("tenantId" = public.current_tenant_id())
      WITH CHECK ("tenantId" = public.current_tenant_id())
  $p$, v_full);

  EXECUTE format('DROP POLICY IF EXISTS cross_tenant ON %s', v_full);
  EXECUTE format($p$
    CREATE POLICY cross_tenant ON %s
      AS PERMISSIVE FOR ALL TO txnet_cross_tenant
      USING (true) WITH CHECK (true)
  $p$, v_full);

  RETURN v_name;
END
$$;

GRANT EXECUTE ON FUNCTION "support"."ensure_message_partition"(DATE) TO txnet_app;

SELECT support.ensure_message_partition(m::date)
  FROM generate_series(date '2026-10-01', date '2027-03-01', interval '1 month') AS m;

-- -----------------------------------------------------------------------------
-- The quiet-down reader (F-1506), over conversation
-- -----------------------------------------------------------------------------
-- Unfinished = anything not resolved or closed. Only who and since when: no
-- subject, no body, no agent.
CREATE VIEW ai.reader_open_ticket WITH (security_barrier) AS
  SELECT c."userId", c."createdAt"
  FROM support.conversation c
  WHERE c."tenantId" = public.current_tenant_id()
    AND c."status" IN ('open', 'pending_user', 'pending_agent');

REVOKE ALL ON ai.reader_open_ticket FROM PUBLIC, txnet_app, txnet_cross_tenant;
GRANT SELECT ON ai.reader_open_ticket TO txnet_ai_reader;

-- -----------------------------------------------------------------------------
-- The platform's default categories (ADR-0112 point 6)
-- -----------------------------------------------------------------------------
WITH defaults(key, sort_order, fa, en) AS (
  VALUES
    ('connection', 10, 'مشکل اتصال', 'Connection problem'),
    ('billing',    20, 'پرداخت و صورتحساب', 'Payments and billing'),
    ('purchase',   30, 'خرید و تمدید سرویس', 'Buying or renewing a service'),
    ('account',    40, 'حساب کاربری', 'My account'),
    ('other',      90, 'سایر موارد', 'Something else')
), made AS (
  INSERT INTO support.support_category (id, "tenantId", key, "sortOrder", "updatedAt")
  SELECT gen_random_uuid(), NULL, key, sort_order, now() FROM defaults
  RETURNING id, key
)
INSERT INTO support.support_category_text ("categoryId", "tenantId", lang, name)
SELECT made.id, NULL, v.lang::identity."Language", v.name
FROM made
JOIN defaults d ON d.key = made.key
CROSS JOIN LATERAL (VALUES ('fa', d.fa), ('en', d.en)) AS v(lang, name);
