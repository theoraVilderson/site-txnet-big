-- F-118-c (D-58, ADR-0105 decision 2): what is counted and billed on use is a
-- catalog row, so a rate card (F-118-d) prices a meter by reference rather
-- than by a column per product. Platform rows only: a meter exists only where
-- code reports it, so this migration — and each later one that ships a
-- reporter — writes it, and no service role may insert, update or delete one.
-- No `tenantId`, so no Row-Level Security: every tenant reads every meter.

CREATE TYPE "catalog"."MeterUnit" AS ENUM ('bytes', 'count', 'seconds', 'tokens');

CREATE TABLE "catalog"."meter" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "unit" "catalog"."MeterUnit" NOT NULL,
    "reportedBy" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "descriptionKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meter_pkey" PRIMARY KEY ("id"),
    -- The shape a capability key has (`vpn.access`), so the text key derives from it.
    CONSTRAINT "meter_key_shape" CHECK ("key" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$')
);

CREATE UNIQUE INDEX "meter_key_key" ON "catalog"."meter"("key");

-- Rate cards and Grants hold a meter's key and quantities in its unit: a
-- changed key orphans them, a changed unit reprices them. Held even for the
-- owner role a migration runs as.
CREATE FUNCTION catalog.meter_is_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."key" IS DISTINCT FROM OLD."key" OR NEW."unit" IS DISTINCT FROM OLD."unit" THEN
    RAISE EXCEPTION 'meter_is_immutable: % keeps its key and unit', OLD."key"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER meter_is_immutable BEFORE UPDATE ON "catalog"."meter"
  FOR EACH ROW EXECUTE FUNCTION catalog.meter_is_immutable();

-- The schema's default privileges grant every service role writes; a meter is
-- read-only to them.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "catalog"."meter" FROM txnet_app, txnet_cross_tenant;
GRANT SELECT ON "catalog"."meter" TO txnet_app, txnet_cross_tenant;

-- The one meter code reports today: VPN bytes, from network-service's traffic
-- accounting. Its name starts as the key, as a migrated capability's did
-- (ADR-0086 decision 5); a human names it.
INSERT INTO "catalog"."meter" ("id", "key", "unit", "reportedBy", "nameKey")
VALUES (gen_random_uuid(), 'vpn.traffic', 'bytes', 'network-service', 'catalog.meter.vpn.traffic.name');
