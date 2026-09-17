-- F-035-h — a campaign delivers by email, in each recipient's language.
--
-- `email` joins the channels. `subject` is the email subject in the source
-- language (null = the translated default); `sourceLang` is the language the
-- admin wrote the campaign in (null = DEFAULT_LANGUAGE, so every earlier row
-- reads as before). `notification_campaign_text` holds the campaign in every
-- other language: a machine draft, or a text an admin published. It has no
-- `tenantId` and no RLS of its own — like the recipient rows it is reached only
-- through a campaign the caller manages. The schema's default privileges
-- (20260909000500) grant it to both app roles.
--
-- Rollback: drop the table, its enum and the two columns; the `email` value
-- stays (Postgres cannot drop one).

ALTER TYPE "notification"."NotificationChannel" ADD VALUE IF NOT EXISTS 'email';

CREATE TYPE "notification"."CampaignTextState" AS ENUM ('draft', 'published');

ALTER TABLE "notification"."notification_campaign"
  ADD COLUMN "subject" TEXT,
  ADD COLUMN "sourceLang" "identity"."Language";

CREATE TABLE "notification"."notification_campaign_text" (
  "id" UUID NOT NULL,
  "campaignId" UUID NOT NULL,
  "lang" "identity"."Language" NOT NULL,
  "subject" TEXT,
  "body" TEXT NOT NULL,
  "state" "notification"."CampaignTextState" NOT NULL DEFAULT 'draft',
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "notification_campaign_text_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "notification_campaign_text_campaignId_lang_key"
  ON "notification"."notification_campaign_text" ("campaignId", "lang");

ALTER TABLE "notification"."notification_campaign_text"
  ADD CONSTRAINT "notification_campaign_text_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "notification"."notification_campaign"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
