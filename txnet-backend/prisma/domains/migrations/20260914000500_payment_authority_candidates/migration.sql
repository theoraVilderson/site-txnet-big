-- Authorities offered for a payment that has none, not yet proven (F-092-ag,
-- ADR-0047 decision 1). A callback that names a payment by `?p=` and meets
-- silence used to write its authority into `gatewayTrackingCode`, the column a
-- verified authority lives in — so a forged one, sent during an outage, held
-- the place the real one needed. It now waits here until the gateway answers.
-- Additive: every existing row reads an empty list, which is the old behaviour.
--
-- Rollback: `ALTER TABLE "billing"."payment_transaction" DROP COLUMN "authorityCandidates"`.

ALTER TABLE "billing"."payment_transaction" ADD COLUMN "authorityCandidates" TEXT[] DEFAULT ARRAY[]::TEXT[];
