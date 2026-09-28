-- F-0608-a (ADR-0101): an admin pins a manual rate with a reason and an expiry,
-- and may end it early. A pin is a `currency_exchange_rate` row with
-- `source = manual_admin`; the rate itself is never edited (invariant #3), so
-- an early end is its own insert-only row. Additive: no existing row changes.

ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'currency_rate_pin';
ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'currency_rate_pin_end';
ALTER TYPE "audit"."AuditTargetType" ADD VALUE IF NOT EXISTS 'currency_exchange_rate';

ALTER TABLE "currency"."currency_exchange_rate"
    ADD COLUMN "reason" TEXT,
    ADD COLUMN "expiresAt" TIMESTAMP(3);

-- A pin has a reason, an expiry after it starts, and the admin who set it; a
-- discovered rate has none of them. Every existing row is `external_api` with
-- all three null, so this validates as it is added.
ALTER TABLE "currency"."currency_exchange_rate"
    ADD CONSTRAINT "currency_exchange_rate_pin_shape" CHECK (
        ("source" = 'manual_admin'
            AND "reason" IS NOT NULL AND btrim("reason") <> ''
            AND "expiresAt" IS NOT NULL AND "expiresAt" > "effectiveAt"
            AND "setByAdminId" IS NOT NULL)
        OR ("source" <> 'manual_admin' AND "reason" IS NULL AND "expiresAt" IS NULL)
    );

CREATE TABLE "currency"."currency_rate_pin_end" (
    "id" UUID NOT NULL,
    "rateId" UUID NOT NULL,
    "endedById" UUID NOT NULL,
    "endedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "currency_rate_pin_end_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "currency_rate_pin_end_rateId_key" ON "currency"."currency_rate_pin_end"("rateId");

ALTER TABLE "currency"."currency_rate_pin_end"
    ADD CONSTRAINT "currency_rate_pin_end_rateId_fkey" FOREIGN KEY ("rateId")
    REFERENCES "currency"."currency_exchange_rate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Insert-only for the services: an end is a fact, never revised.
GRANT SELECT, INSERT ON "currency"."currency_rate_pin_end" TO txnet_app, txnet_cross_tenant;

-- The platform's Admin pins; the service also requires the platform-owner tenant.
INSERT INTO identity.permission (id, key)
VALUES (gen_random_uuid(), 'currency.pin')
ON CONFLICT (key) DO NOTHING;

INSERT INTO identity.role_permission ("roleId", "permissionId")
SELECT r.id, p.id
FROM identity.role r
JOIN identity.permission p ON p.key = 'currency.pin'
WHERE r.name = 'Admin'
ON CONFLICT DO NOTHING;
