-- F-027-cd — a panel is registered once (ADR-0090 decision 1, D-48): no two
-- panels share a normalised `apiBaseUrl`. Two rows over one panel each read
-- every client on it, report the other's as orphans and, under
-- `delete_remote`, delete them.
--
-- The identity is the address, never the host: several Docker panels on one
-- server differ by port or path and stay allowed. Normalised = lower-case,
-- no user info, query or fragment, the scheme's default port written out,
-- no trailing `/`, the path kept. `https://Fra.example.com/Panel/` and
-- `https://fra.example.com:443/panel` are one panel.
--
-- An expression index, not a column: every writer (billing's routes, a seed,
-- a Go test) is held by it, and billing looks the holder up through this same
-- function, so there is one normaliser. Archived panels count: the refusal
-- names the archived one, and restoring it is the answer.
--
-- Additive; the dev database held no duplicate when this was written. A
-- database that does fails here, on purpose — pick the row to keep first.

CREATE FUNCTION "network"."panel_api_address"(url text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT CASE WHEN m IS NULL THEN lower(btrim(url)) ELSE
    m[1] || '://' || m[2] || ':' ||
    coalesce(nullif(m[3], '')::int::text, CASE m[1] WHEN 'https' THEN '443' WHEN 'http' THEN '80' ELSE '' END) ||
    rtrim(m[4], '/')
  END
  FROM (SELECT regexp_match(
    lower(btrim(url)),
    '^([a-z][a-z0-9+.-]*)://(?:[^@/?#]*@)?(\[[^]]*\]|[^:/?#]*)(?::([0-9]*))?([^?#]*)'
  ) AS m) s
$$;

CREATE UNIQUE INDEX "panel_api_address_key"
  ON "network"."panel" ("network"."panel_api_address"("apiBaseUrl"))
  WHERE "apiBaseUrl" IS NOT NULL;
