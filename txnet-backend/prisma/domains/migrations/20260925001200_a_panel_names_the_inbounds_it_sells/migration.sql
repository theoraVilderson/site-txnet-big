-- F-114-b — a panel names the inbounds it sells, and a config names the one it
-- is on (network `contract.inbounds.md`, user 2026-09-25).
--
-- Reported: the system did not know which v2ray inbounds to create a user on —
-- the pass took the first enabled inbound of the group's one protocol.
--
-- 1. `panel_inbound`: every inbound `network-service` last read from the panel
--    (`ListInbounds`), and the admin's pick (`sold`, `maxClients`). The read
--    owns the panel's columns and `goneAt`; the admin owns the pick.
-- 2. `panel.inboundPlacement` (`all` | `spread`), `panel.maxClients`, and
--    `panel.inboundsReadAt` (null = read me on the next pass).
-- 3. `config.inboundRemoteId`: the inbound fulfilment placed the config on.
--    Existing rows stay null; the pass resolves those to the lowest picked
--    inbound of their protocol, and to `no_inbound` when nothing is picked.
-- 4. `config_group_panel_once` keys (grant, panel, inbound): under `all` a
--    Grant holds one config per picked inbound of a panel. A null inbound is
--    keyed as '' so a legacy row still holds its panel once.
-- 5. `panel_group.protocol` is dropped: the protocols are the picked inbounds'.
--
-- Nothing is picked on any panel after this runs, so no new config is placed
-- until an admin picks (user 2026-09-25: never the first enabled inbound).
-- Configs already placed are untouched. Rollback: re-add `protocol` with its
-- default, restore the (grant, panel) index (refused while a Grant has two
-- rows on one panel), drop the three panel columns, the config column, the
-- table, its two functions and the enum.

-- CreateEnum
CREATE TYPE "network"."InboundPlacement" AS ENUM ('all', 'spread');

-- AlterTable
ALTER TABLE "network"."panel"
  ADD COLUMN "inboundPlacement" "network"."InboundPlacement" NOT NULL DEFAULT 'all',
  ADD COLUMN "maxClients" INTEGER,
  ADD COLUMN "inboundsReadAt" TIMESTAMP(3),
  ADD CONSTRAINT "panel_max_clients_positive" CHECK ("maxClients" IS NULL OR "maxClients" >= 1);

-- AlterTable
ALTER TABLE "network"."config" ADD COLUMN "inboundRemoteId" TEXT;

-- AlterTable
ALTER TABLE "network"."panel_group" DROP COLUMN "protocol";

-- CreateTable
CREATE TABLE "network"."panel_inbound" (
    "panelId" UUID NOT NULL,
    "remoteId" TEXT NOT NULL,
    "tenantId" UUID,
    "tag" TEXT NOT NULL DEFAULT '',
    "protocol" "network"."ConfigProtocol",
    "port" INTEGER NOT NULL DEFAULT 0,
    "host" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "goneAt" TIMESTAMP(3),
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sold" BOOLEAN NOT NULL DEFAULT false,
    "maxClients" INTEGER,

    CONSTRAINT "panel_inbound_pkey" PRIMARY KEY ("panelId","remoteId"),
    CONSTRAINT "panel_inbound_max_clients_positive" CHECK ("maxClients" IS NULL OR "maxClients" >= 1)
);

-- CreateIndex
CREATE INDEX "panel_inbound_tenantId_idx" ON "network"."panel_inbound"("tenantId");

-- AddForeignKey
ALTER TABLE "network"."panel_inbound" ADD CONSTRAINT "panel_inbound_panelId_fkey" FOREIGN KEY ("panelId") REFERENCES "network"."panel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
DROP INDEX "network"."config_group_panel_once";
CREATE UNIQUE INDEX "config_group_panel_once" ON "network"."config"("grantId", "panelId", coalesce("inboundRemoteId", ''))
  WHERE "credentialGroupId" IS NOT NULL AND "drainedAt" IS NULL;

-- -----------------------------------------------------------------------------
-- An inbound carries its panel's tenant
-- -----------------------------------------------------------------------------
CREATE FUNCTION network.panel_inbound_tenant() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  SELECT "tenantId" INTO NEW."tenantId" FROM network.panel WHERE id = NEW."panelId";
  RETURN NEW;
END
$$;

CREATE TRIGGER panel_inbound_tenant BEFORE INSERT OR UPDATE OF "tenantId", "panelId" ON "network"."panel_inbound"
  FOR EACH ROW EXECUTE FUNCTION network.panel_inbound_tenant();

CREATE FUNCTION network.panel_inbound_follows_panel() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE network.panel_inbound SET "tenantId" = NEW."tenantId" WHERE "panelId" = NEW.id;
  RETURN NEW;
END
$$;

CREATE TRIGGER panel_inbound_follows_panel AFTER UPDATE OF "tenantId" ON "network"."panel"
  FOR EACH ROW EXECUTE FUNCTION network.panel_inbound_follows_panel();

-- -----------------------------------------------------------------------------
-- Row-Level Security: shared-read, as `network.panel`
-- -----------------------------------------------------------------------------
ALTER TABLE network.panel_inbound ENABLE ROW LEVEL SECURITY;
ALTER TABLE network.panel_inbound FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "network"."panel_inbound" TO txnet_app, txnet_cross_tenant;

CREATE POLICY tenant_isolation ON "network"."panel_inbound"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" IS NULL OR "tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());

CREATE POLICY cross_tenant ON "network"."panel_inbound"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
