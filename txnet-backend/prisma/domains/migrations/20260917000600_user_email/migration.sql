-- F-035-g — a user has an email address, verified by an emailed code.
--
-- `user.email` is written only after an `email_verify` code mailed to it was
-- confirmed, so a non-null address is a verified one; unique within a tenant,
-- like `phoneNumber` (ADR-0023). `email` is an OTP channel reserved to that one
-- purpose (D-39). An `otp_code` row records either the phone or the address
-- its code went to, never both.
--
-- Rollback: drop the two index/unique, the columns, restore
-- `otp_code.phoneNumber NOT NULL` (after deleting email rows). Enum values
-- cannot be dropped in place; leave them.

ALTER TYPE "identity"."OtpPurpose" ADD VALUE 'email_verify';
ALTER TYPE "identity"."OtpChannel" ADD VALUE 'email';

ALTER TABLE "identity"."user"
  ADD COLUMN "email" TEXT,
  ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "user_tenantId_email_key" ON "identity"."user"("tenantId", "email");

ALTER TABLE "identity"."otp_code"
  ALTER COLUMN "phoneNumber" DROP NOT NULL,
  ADD COLUMN "email" TEXT,
  ADD CONSTRAINT "otp_code_one_destination"
    CHECK (("phoneNumber" IS NULL) <> ("email" IS NULL));

CREATE INDEX "otp_code_email_purpose_consumedAt_idx" ON "identity"."otp_code"("email", "purpose", "consumedAt");
