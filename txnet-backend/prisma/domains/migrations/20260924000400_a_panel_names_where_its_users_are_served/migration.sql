-- F-027-bg — a panel names where its users are served their links.
--
-- Hiddify serves every link and subscription under its client proxy path,
-- often on a domain of its own, and its admin API does not report that path.
-- The owner registers it: the scheme, host and client proxy path, as
-- `apiBaseUrl` is for the admin side. The driver reads links from it and
-- answers the subscription under it; with none it builds no link.
--
-- Only a pull panel is called, and a push panel's NAS serves no links, hence
-- the CHECK.
--
-- Additive and nullable: no backfill. Rollback: drop the constraint and the
-- column.

ALTER TABLE "network"."panel" ADD COLUMN "clientBaseUrl" TEXT;

ALTER TABLE "network"."panel"
    ADD CONSTRAINT "panel_client_base_url_is_pull_only"
    CHECK ("clientBaseUrl" IS NULL OR "transport" = 'pull');
