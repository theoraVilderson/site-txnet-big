-- F-027-a — a Panel declares its driver, its counter semantics and its
-- transport (ADR-0074), and carries the figures the ceiling horizon is
-- computed from (ADR-0072).
--
-- 1. `driverType` replaces `panelType`. The old enum named two Xray builds;
--    the new one names all thirteen driver families (ADR-0071), including the
--    `fake` driver the conformance suite runs against (F-027-j).
-- 2. `counterSemantics` and `transport` are the declaration one normaliser
--    turns into a single delta stream. They change arithmetic, so they are NOT
--    NULL with no default: a panel row that did not answer the questionnaire
--    cannot exist.
-- 3. `capabilities` is the questionnaire's answers. JSONB on purpose — its
--    shape is validated and versioned on write, not by the database (ADR-0074,
--    accepted cost) — but it is an object, and that much is checked here.
-- 4. `reviewState` is where a panel is refused: at registration, before it has
--    users, rather than at billing time.
-- 5. `panelState` (was `status`) gains `throttled_or_blocked`. A `429`/`403` is
--    not `down`: the panel is answering and refusing us, so it is not retried
--    through — `blockedSince` records when that started (ADR-0072).
-- 6. `maxLineRateBps`, `observedWriteLatencyMs` and `maxRequestsPerMinute`
--    are what size a ceiling in seconds rather than bytes (F-027-u) and what
--    keeps the hot loop from being a denial of service on a customer's own
--    server (F-027-v).
-- 7. `ConfigProtocol` widens from the four Xray protocols to nine: the two
--    modern UDP protocols the newer Xray panels add, WireGuard, and the two an
--    ISP billing system reports over RADIUS.
--
-- DESTRUCTIVE, and safe to be: `network.panel` and `network.config` have never
-- been written — no service reads or writes this schema (`source: []`), and
-- 20260914001600_entitlement_grant already refused to run over a non-empty
-- `network.config` for the same reason. Both are asserted below rather than
-- assumed, because a dropped column and a recreated enum type cannot be undone
-- by the next migration.
--
-- Rollback: recreate `PanelType` and `PanelStatus` as 20260908000000_init
-- declares them, rename `panelState` back to `status`, drop the columns and
-- types this file adds, and narrow `ConfigProtocol` to its first four values.
-- The rollback expires with the first `panel` row.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM network.panel) THEN
    RAISE EXCEPTION 'network.panel has rows; F-027-a drops a column and recreates two enum types over an assumed-empty table';
  END IF;
  IF EXISTS (SELECT 1 FROM network.config) THEN
    RAISE EXCEPTION 'network.config has rows; F-027-a recreates ConfigProtocol and cannot re-read a stored protocol';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------
CREATE TYPE "network"."PanelOwnershipType" AS ENUM ('platform', 'tenant');
CREATE TYPE "network"."DriverType" AS ENUM ('marzban', 'marzneshin', 'sanaee', 'x_ui', 'three_x_ui', 's_ui', 'hiddify', 'core_xray', 'ibsng', 'cloudius', 'mikrotik_user_manager', 'mikrotik_wireguard', 'fake');
CREATE TYPE "network"."CounterSemantics" AS ENUM ('cumulative', 'session', 'reset_on_read');
CREATE TYPE "network"."PanelTransport" AS ENUM ('pull', 'push');
CREATE TYPE "network"."PanelReviewState" AS ENUM ('pending', 'accepted', 'accepted_low_trust', 'refused');
CREATE TYPE "network"."OrphanPolicy" AS ENUM ('report_only', 'adopt', 'delete_remote');

-- `PanelStatus` -> `PanelState`, one value wider. Recreated rather than
-- `ALTER TYPE ... ADD VALUE`: a value added inside a transaction cannot be used
-- in that same transaction, and `prisma migrate` runs this file as one.
ALTER TABLE "network"."panel" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "network"."panel" ALTER COLUMN "status" TYPE TEXT;
DROP TYPE "network"."PanelStatus";
CREATE TYPE "network"."PanelState" AS ENUM ('healthy', 'degraded', 'maintenance', 'down', 'throttled_or_blocked');
ALTER TABLE "network"."panel" ALTER COLUMN "status" TYPE "network"."PanelState" USING "status"::"network"."PanelState";
ALTER TABLE "network"."panel" RENAME COLUMN "status" TO "panelState";
ALTER TABLE "network"."panel" ALTER COLUMN "panelState" SET DEFAULT 'healthy';

-- The same move on `ConfigProtocol`, which only widens.
ALTER TABLE "network"."config" ALTER COLUMN "protocol" TYPE TEXT;
DROP TYPE "network"."ConfigProtocol";
CREATE TYPE "network"."ConfigProtocol" AS ENUM ('vmess', 'vless', 'trojan', 'shadowsocks', 'hysteria2', 'tuic', 'wireguard', 'openvpn', 'pppoe');
ALTER TABLE "network"."config" ALTER COLUMN "protocol" TYPE "network"."ConfigProtocol" USING "protocol"::"network"."ConfigProtocol";

-- -----------------------------------------------------------------------------
-- The declaration
-- -----------------------------------------------------------------------------
ALTER TABLE "network"."panel" DROP COLUMN "panelType";
DROP TYPE "network"."PanelType";

ALTER TABLE "network"."panel"
    ADD COLUMN "ownershipType" "network"."PanelOwnershipType" NOT NULL DEFAULT 'platform',
    ADD COLUMN "apiBaseUrl" TEXT,
    ADD COLUMN "driverType" "network"."DriverType" NOT NULL,
    ADD COLUMN "counterSemantics" "network"."CounterSemantics" NOT NULL,
    ADD COLUMN "transport" "network"."PanelTransport" NOT NULL,
    ADD COLUMN "capabilities" JSONB,
    ADD COLUMN "reviewState" "network"."PanelReviewState" NOT NULL DEFAULT 'pending',
    ADD COLUMN "orphanPolicy" "network"."OrphanPolicy" NOT NULL DEFAULT 'report_only',
    ADD COLUMN "blockedSince" TIMESTAMP(3),
    ADD COLUMN "maxRequestsPerMinute" INTEGER NOT NULL DEFAULT 60,
    ADD COLUMN "maxLineRateBps" BIGINT,
    ADD COLUMN "observedWriteLatencyMs" INTEGER,
    ADD COLUMN "lastHealthyAt" TIMESTAMP(3),
    ADD COLUMN "lastSuccessfulCollectionAt" TIMESTAMP(3);

-- `ownershipType` and `tenantId` are one fact written twice: a dedicated panel
-- is a tenant's, a shared-pool panel is the platform's. Whichever one a future
-- writer sets, the other cannot disagree — the alert routing and the cost
-- attribution read `ownershipType`, and RLS reads `tenantId`.
ALTER TABLE "network"."panel"
    ADD CONSTRAINT "panel_ownership_matches_tenant" CHECK (("ownershipType" = 'tenant') = ("tenantId" IS NOT NULL)),
    -- A push source is never called, and a pull source is useless without an
    -- address. This is checked here because a driver that has to guess a base
    -- URL guesses it per family.
    ADD CONSTRAINT "panel_pull_has_base_url" CHECK ("transport" <> 'pull' OR "apiBaseUrl" IS NOT NULL),
    ADD CONSTRAINT "panel_capabilities_object" CHECK ("capabilities" IS NULL OR jsonb_typeof("capabilities") = 'object'),
    -- A budget of zero would stop collection on a panel silently.
    ADD CONSTRAINT "panel_request_budget_positive" CHECK ("maxRequestsPerMinute" > 0),
    ADD CONSTRAINT "panel_line_rate_positive" CHECK ("maxLineRateBps" IS NULL OR "maxLineRateBps" > 0),
    ADD CONSTRAINT "panel_write_latency_not_negative" CHECK ("observedWriteLatencyMs" IS NULL OR "observedWriteLatencyMs" >= 0),
    -- `blockedSince` is the clock on `throttled_or_blocked` and means nothing
    -- without it.
    ADD CONSTRAINT "panel_blocked_since_needs_state" CHECK (("panelState" = 'throttled_or_blocked') = ("blockedSince" IS NOT NULL));
