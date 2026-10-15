-- F-803-c: a manual gateway's destinations (the cards and wallets a payer is
-- shown) are written through gateway admin, each write audited by its own
-- action (billing/contract.manual-transfer.md "Gateway admin").
--
-- Additive only. (Enum values cannot be dropped; unused they are harmless.)

ALTER TYPE "audit"."AdminAction" ADD VALUE 'gateway_manual_destination_create';
ALTER TYPE "audit"."AdminAction" ADD VALUE 'gateway_manual_destination_update';
ALTER TYPE "audit"."AdminAction" ADD VALUE 'gateway_manual_destination_delete';
