-- F-033-j — canned replies (catalog §11.3, user 2026-10-03): a short key and a
-- text per language, owned like a category (ADR-0112 point 5): `tenantId` NULL
-- is the platform's defaults, read by every tenant and written by none; a
-- tenant's own reply with the same key hides the default. Written with
-- `support.manage`, inserted by `support.agent`.
--
-- Additive. Rollback: DROP TABLE support.canned_reply_text, support.canned_reply.

CREATE TABLE "support"."canned_reply" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "key" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "canned_reply_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "canned_reply_key_shape" CHECK ("key" ~ '^[a-z0-9_]{1,40}$')
);

CREATE TABLE "support"."canned_reply_text" (
    "cannedReplyId" UUID NOT NULL,
    "tenantId" UUID,
    "lang" "identity"."Language" NOT NULL,
    "body" TEXT NOT NULL,

    CONSTRAINT "canned_reply_text_pkey" PRIMARY KEY ("cannedReplyId","lang"),
    CONSTRAINT "canned_reply_text_body" CHECK (char_length("body") BETWEEN 1 AND 4000)
);

CREATE UNIQUE INDEX "canned_reply_tenantId_key_key" ON "support"."canned_reply"("tenantId", "key");
-- NULLs are distinct to a unique index: the platform's keys are held unique on their own.
CREATE UNIQUE INDEX "canned_reply_platform_key" ON "support"."canned_reply"("key") WHERE "tenantId" IS NULL;

ALTER TABLE "support"."canned_reply_text" ADD CONSTRAINT "canned_reply_text_cannedReplyId_fkey"
  FOREIGN KEY ("cannedReplyId") REFERENCES "support"."canned_reply"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Shared-read, as the categories (invariant 4): the platform's rows (NULL) and
-- the tenant's own; a tenant never writes a NULL row.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['support.canned_reply', 'support.canned_reply_text']
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

-- The platform's defaults.
WITH defaults(key, sort_order, fa, en) AS (
  VALUES
    ('greeting', 10,
     'سلام {user.name}، {agent.name} هستم از پشتیبانی {tenant.name}. چطور می‌توانم کمکتان کنم؟',
     'Hi {user.name}, this is {agent.name} from {tenant.name} support. How can I help?'),
    ('more_info', 20,
     'برای بررسی «{conversation.subject}» لطفاً بگویید از چه دستگاه و برنامه‌ای استفاده می‌کنید و مشکل از چه زمانی شروع شد.',
     'To look into "{conversation.subject}", please tell us which device and app you use and since when the problem started.'),
    ('reconnect', 30,
     'لطفاً یک بار اتصال را قطع و دوباره وصل کنید و اگر برنامه به‌روزرسانی دارد، آن را نصب کنید. نتیجه را همین‌جا بنویسید.',
     'Please disconnect and connect again once, and install the app''s update if there is one. Let us know here how it went.'),
    ('resolved_check', 40,
     '{user.name} عزیز، امیدواریم مشکل حل شده باشد. اگر هنوز چیزی هست، همین‌جا پاسخ دهید.',
     'We hope this is sorted, {user.name}. If anything is still wrong, just reply here.')
), made AS (
  INSERT INTO support.canned_reply (id, "tenantId", key, "sortOrder", "updatedAt")
  SELECT gen_random_uuid(), NULL, key, sort_order, now() FROM defaults
  RETURNING id, key
)
INSERT INTO support.canned_reply_text ("cannedReplyId", "tenantId", lang, body)
SELECT made.id, NULL, v.lang::identity."Language", v.body
FROM made
JOIN defaults d ON d.key = made.key
CROSS JOIN LATERAL (VALUES ('fa', d.fa), ('en', d.en)) AS v(lang, body);
