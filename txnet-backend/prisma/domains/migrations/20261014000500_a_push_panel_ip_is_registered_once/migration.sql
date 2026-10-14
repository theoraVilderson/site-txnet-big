-- F-027-ff — a push panel's `ipAddress` is registered once (ADR-0130
-- decision 5, D-67). The RADIUS allowlist (`radius/postgres.go`) keys push
-- panels by address and leaves out every panel that shares one, so two push
-- panels at one IP — across tenants — dropped each other off it with only a
-- log line.
--
-- The address is normalised the way the allowlist parses it (Go
-- `netip.ParseAddr(...).Unmap()`): `inet`'s canonical spelling, an
-- IPv4-mapped IPv6 address written as its IPv4. A value `inet` cannot parse is
-- kept trimmed and lower-cased; the allowlist ignores it anyway. One
-- function, shared by the index and billing's look-up, as
-- `panel_api_address` (20260926001100) is for an API address.
--
-- Only live push panels count: the allowlist reads no archived panel and no
-- pull panel, so restoring an archived one is where a clash is refused.
--
-- Additive. A database that already holds a duplicate stops here with every
-- clash listed (address and panel ids) — never a bare unique violation, and
-- never an index silently skipped. Retire or re-address one of each pair,
-- then deploy again.

CREATE FUNCTION "network"."panel_push_address"(ip text) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE
  a inet;
BEGIN
  a := btrim(ip)::inet;
  IF family(a) = 6 AND a << '::ffff:0.0.0.0/96'::inet THEN
    RETURN host('0.0.0.0'::inet + (a - '::ffff:0.0.0.0'::inet));
  END IF;
  RETURN host(a);
EXCEPTION WHEN invalid_text_representation THEN
  RETURN lower(btrim(ip));
END
$$;

DO $$
DECLARE
  clashes text;
BEGIN
  SELECT string_agg(format('%s: %s', addr, ids), '; ')
    INTO clashes
    FROM (
      SELECT "network"."panel_push_address"("ipAddress") AS addr,
             string_agg("id"::text, ', ' ORDER BY "id") AS ids
        FROM "network"."panel"
       WHERE "transport" = 'push' AND "retiredAt" IS NULL AND "ipAddress" IS NOT NULL
       GROUP BY 1
      HAVING count(*) > 1
    ) d;
  IF clashes IS NOT NULL THEN
    RAISE EXCEPTION 'push panels share an ipAddress (F-027-ff); retire or re-address one of each, then deploy again: %', clashes;
  END IF;
END
$$;

CREATE UNIQUE INDEX "panel_push_address_key"
  ON "network"."panel" ("network"."panel_push_address"("ipAddress"))
  WHERE "transport" = 'push' AND "retiredAt" IS NULL AND "ipAddress" IS NOT NULL;
