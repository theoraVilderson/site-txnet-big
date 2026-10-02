-- F-038-q (ADR-0109 point 9): an offer goes to one account once. The
-- guardrail (`OfferGuardrails.allowed`) reads it before the write; this holds
-- it when two runs both read "not given yet". A stopped or expired row gave
-- nothing, so it is outside the index — the same set as `OFFER_GIVEN`.
CREATE UNIQUE INDEX "action_offer_once" ON "ai"."action" ("tenantId", "subjectKind", "subjectId", "offerId") WHERE "offerId" IS NOT NULL AND "status" IN ('scheduled', 'awaiting_approval', 'sent', 'accepted', 'dismissed');
