-- F-1506 (ADR-0109 points 6, 8): the quiet-down step holds every suggestion
-- while the subject has an open ticket. `support.ticket` is keyed by user with
-- no `tenantId`, so — as `20261002000400_ai_profile_inputs` did for sessions,
-- notices and wallets — the reader gets a view that scopes it by the user's
-- tenant and carries only who and since when: no subject line, no body.
-- `pending` is open too: it waits on the user, and the problem is not over.
-- The failed-payment window reads `billing.payment_transaction`, which the
-- reader already holds under its RLS.
--
-- Additive. Rollback: DROP VIEW ai.reader_open_ticket.

CREATE VIEW ai.reader_open_ticket WITH (security_barrier) AS
  SELECT t."userId", t."createdAt"
  FROM support.ticket t
  JOIN identity."user" u ON u."id" = t."userId"
  WHERE u."tenantId" = public.current_tenant_id()
    AND t."status" IN ('open', 'pending');

REVOKE ALL ON ai.reader_open_ticket FROM PUBLIC, txnet_app, txnet_cross_tenant;
GRANT SELECT ON ai.reader_open_ticket TO txnet_ai_reader;
