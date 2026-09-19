// The brand the panel wears: the domain's (F-066-v, ADR-0059).
//
// `GET /api/public/tenant/branding` answers for the tenant whose *Host* asked (tenant
// `contract.branding.md` rule 6), and no session is sent with it. That is the
// whole of "`ResolvedTenant.brand ?? current`" on this side: on a reseller's
// domain its owner is signed in to their own platform tenant, and the page is
// still the reseller's — so the brand is read by host, never from the session.
//
// Read on the server, in the root layout, so the first HTML already carries the
// title, favicon, colours and logo — a white-label page that flashes the
// platform's name before its own is the leak this row exists to close.
//
// Server-only: it opens a socket with `node:http` (`host-get.ts`). Client
// components import its `Branding` type alone.
import type { CSSProperties } from "react";
import { TENANT_PUBLIC, getJsonAsHost } from "./host-get";

/** The fields of tenant's branding view the panel renders. */
export interface Branding {
  brandName: string;
  logoLightUrl: string | null;
  logoDarkUrl: string | null;
  faviconUrl: string | null;
  ogImageUrl: string | null;
  primaryColorHex: string | null;
  secondaryColorHex: string | null;
}

const HEX = /^#[0-9a-f]{6}$/i;
const BRAND_NAME_MAX = 64;
const TIMEOUT_MS = 2000;
/** A replaced image may already be five minutes stale (file route `max-age=300`). */
const CACHE_MS = 60_000;

function hex(v: unknown): string | null {
  return typeof v === "string" && HEX.test(v) ? v : null;
}

function httpsUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try {
    return new URL(v).protocol === "https:" ? v : null;
  } catch {
    return null;
  }
}

/**
 * The branding in a `{ok, data}` envelope, or null. Every field is checked
 * again here (tenant rule 3: the schema is the second wall, the renderer the
 * first): a colour is `#rrggbb` or nothing, a URL `https` or nothing.
 */
export function parseBranding(body: unknown): Branding | null {
  if (!body || typeof body !== "object") return null;
  const { ok, data } = body as { ok?: unknown; data?: unknown };
  if (ok !== true || !data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const name = typeof d.brandName === "string" ? d.brandName.trim() : "";
  if (!name || name.length > BRAND_NAME_MAX) return null;
  return {
    brandName: name,
    logoLightUrl: httpsUrl(d.logoLightUrl),
    logoDarkUrl: httpsUrl(d.logoDarkUrl),
    faviconUrl: httpsUrl(d.faviconUrl),
    ogImageUrl: httpsUrl(d.ogImageUrl),
    primaryColorHex: hex(d.primaryColorHex),
    secondaryColorHex: hex(d.secondaryColorHex),
  };
}

/**
 * The theme tokens the brand overrides, as a style for `<html>` — so they win
 * over every theme block in `globals.css`. React sets them as properties, and
 * only checked `#rrggbb` values reach it.
 */
export function brandStyle(brand: Branding | null): CSSProperties {
  const primary = brand?.primaryColorHex;
  if (!primary) return {};
  const style: Record<string, string> = {
    "--accent-primary": primary,
    "--accent-glow": `color-mix(in srgb, ${primary} 25%, transparent)`,
    "--leaf-bg": `color-mix(in srgb, ${primary} 10%, transparent)`,
  };
  const secondary = brand?.secondaryColorHex;
  if (secondary) {
    style["--card-gradient"] = `linear-gradient(135deg, ${primary} 0%, ${secondary} 100%)`;
  }
  return style as CSSProperties;
}

/**
 * Keyed by a host the visitor chose — every host reaches this app — so it is
 * bounded: past the cap it starts over rather than growing with a scan.
 */
const CACHE_MAX = 500;
const cache = new Map<string, { at: number; brand: Branding | null }>();

/** For the spec. */
export function clearBrandingCache() {
  cache.clear();
}

/**
 * The branding of `host`, or null — the neutral look — when the host is not a
 * tenant's door, the service does not answer or the answer does not parse.
 * Never another tenant's brand, and never a failed page for want of one.
 *
 * `origin` is `TENANT_SERVICE_ORIGIN` (the internal hop, as the session guard's
 * `AUTH_SERVICE_ORIGIN`), else the visitor's own `https://<host>`, where
 * Traefik routes `/api/public/tenant` on every host.
 */
export async function fetchBranding(
  host: string,
  origin: string = process.env.TENANT_SERVICE_ORIGIN || `https://${host}`,
): Promise<Branding | null> {
  const hit = cache.get(host);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.brand;
  const brand = parseBranding(await getJsonAsHost(origin, `${TENANT_PUBLIC}/branding`, host, TIMEOUT_MS));
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(host, { at: Date.now(), brand });
  return brand;
}
