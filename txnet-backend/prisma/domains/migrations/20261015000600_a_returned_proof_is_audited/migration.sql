-- F-805-a: a person sending a payer's transfer proof back (`reject` with
-- `resubmit`) is audited like a rejection. Additive; an enum value cannot be
-- dropped, and unused it is harmless.
ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'payment_manual_return';
