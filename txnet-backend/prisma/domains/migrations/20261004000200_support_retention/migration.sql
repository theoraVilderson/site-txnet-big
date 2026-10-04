-- F-033-n — retention (user, 2026-10-04):
--   * an attachment's file is deleted 90 days after its conversation closed
--     (`SUPPORT_ATTACHMENT_RETENTION_DAYS`); the row stays with `objectKey`
--     NULL and `expiredAt` set, so the thread still says a file was there;
--   * a message month older than `SUPPORT_MESSAGE_RETENTION_MONTHS` (12) is
--     archived per tenant on the storage port by support-service, then its
--     partition is detached and dropped by `support.drop_message_partition`
--     (ADR-0112 point 3: retention is a dropped partition, never a DELETE).
--
-- Additive. Rollback: DROP FUNCTION; restore NOT NULL on objectKey once no row
-- is expired; drop the column and the CHECK.

ALTER TABLE "support"."message_attachment"
  ALTER COLUMN "objectKey" DROP NOT NULL,
  ADD COLUMN "expiredAt" TIMESTAMP(3),
  ADD CONSTRAINT "message_attachment_expired" CHECK (("objectKey" IS NULL) = ("expiredAt" IS NOT NULL));

-- The file sweep: unexpired files by conversation.
CREATE INDEX "message_attachment_unexpired_idx" ON "support"."message_attachment"("conversationId")
  WHERE "expiredAt" IS NULL;

-- Detach, then drop, one month of `support.message`. The caller must have
-- archived it and removed its attachment rows first (their FK is RESTRICT, so
-- the detach refuses otherwise — nothing is lost by a wrong order).
-- Refuses the current month and the one before it whatever it is asked: a
-- misconfigured retention can archive too early, never drop live messages.
-- Only the cross-tenant role (support's sweep) may call it.
CREATE OR REPLACE FUNCTION "support"."drop_message_partition"(a_month DATE)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = support, public, pg_temp
AS $$
DECLARE
  v_from DATE := date_trunc('month', a_month)::date;
  v_name TEXT := 'message_' || to_char(v_from, 'YYYY_MM');
BEGIN
  IF v_from >= (date_trunc('month', now()) - INTERVAL '1 month')::date THEN
    RAISE EXCEPTION 'support.message partition % is too recent to drop', v_name;
  END IF;
  IF to_regclass('support.' || quote_ident(v_name)) IS NULL THEN
    RETURN false;
  END IF;
  EXECUTE format('ALTER TABLE %I.%I DETACH PARTITION %I.%I', 'support', 'message', 'support', v_name);
  EXECUTE format('DROP TABLE %I.%I', 'support', v_name);
  RETURN true;
END
$$;

REVOKE ALL ON FUNCTION "support"."drop_message_partition"(DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "support"."drop_message_partition"(DATE) TO txnet_cross_tenant;
