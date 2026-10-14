-- F-027-ex — every pass looks for the panel's anchor first (ADR-0130
-- decision 2, D-67). A panel answering with neither its own anchor nor
-- another panel's has been re-pointed to a server we do not know, or the same
-- one was reinstalled; only a person can say which, so it halts unread and
-- unconverged. Another panel's anchor stays `foreign_claim`, naming it.
--
-- Additive: one enum value.

ALTER TYPE "network"."PanelDriftEventType" ADD VALUE 'identity_lost';
