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
// Server-only: it opens a connection with `undici` (`host-get.ts`). Client
// components import its `Branding` type alone.

import type { CSSProperties } from "react";
import { TENANT_PUBLIC, getJsonAsHost } from "./host-get";
import { isValidJsonObject } from "@util/helper";

/** Fields of the tenant branding view rendered by the panel. */
export interface Branding {
  brandName: string;
  logoLightUrl: string | null;
  logoDarkUrl: string | null;
  faviconUrl: string | null;
  ogImageUrl: string | null;
  primaryColorHex: string | null;
  secondaryColorHex: string | null;
}

const HEX_PATTERN = /^#[0-9a-f]{6}$/i;
const BRAND_NAME_MAX = 64;
const TIMEOUT_MS = 2000;
/** Stale cache window: an updated asset may already be cached upstream for up to 5 minutes. */
const CACHE_MS = 60_000;
/** A host with no brand (no tenant's, or the service did not answer): short, so a blip clears itself. */
const NEGATIVE_CACHE_MS = 10_000;
/** Bounded cache capacity to mitigate memory starvation under domain scan attacks. */
const CACHE_MAX = 500;

/** A `#rrggbb` colour (tenant `contract.branding.md` rule 3, a CHECK there too), or null. */
function sanitizeHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return HEX_PATTERN.test(trimmed) ? trimmed : null;
}

/** Enforces valid HTTPS URL protocol. Drops plain HTTP or non-URL inputs. */
function sanitizeHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function parseBranding(body: unknown): Branding | null {
  // The `{ ok: true, data: { ... } }` envelope, or nothing.
  if (
    !isValidJsonObject(body) ||
    body.ok !== true ||
    !isValidJsonObject(body.data)
  ) {
    return null;
  }

  const { data } = body;
  const brandName =
    typeof data.brandName === "string" ? data.brandName.trim() : "";

  // 1-64 or the whole brand is null (panel-web contract.branding.md rule 1):
  // a name the schema would refuse is not this tenant's checked brand.
  if (!brandName || brandName.length > BRAND_NAME_MAX) {
    return null;
  }

  const sanitizedBranding: Branding = {
    brandName,
    logoLightUrl: sanitizeHttpsUrl(data.logoLightUrl),
    logoDarkUrl: sanitizeHttpsUrl(data.logoDarkUrl),
    faviconUrl: sanitizeHttpsUrl(data.faviconUrl),
    ogImageUrl: sanitizeHttpsUrl(data.ogImageUrl),
    primaryColorHex: sanitizeHex(data.primaryColorHex),
    secondaryColorHex: sanitizeHex(data.secondaryColorHex),
  };

  return sanitizedBranding;
}

/** Computes WCAG relative luminance for a verified hex color. */
function luminance(hexColor: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const channel = parseInt(hexColor.slice(i, i + 2), 16) / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Selects an accessible foreground text color (white or dark) based on the background.
 * Ensures a minimum 3:1 contrast ratio against the primary accent surface.
 */
function labelOn(hexColor: string): string {
  const contrastWithWhite = 1.05 / (luminance(hexColor) + 0.05);
  return contrastWithWhite >= 3 ? "#ffffff" : "#111111";
}

/**
 * Generates custom CSS variables for `<html>` to override platform default tokens.
 */
export function brandStyle(brand: Branding | null): CSSProperties {
  const primary = brand?.primaryColorHex;
  if (!primary) return {};

  const style: Record<string, string> = {
    "--accent-primary": primary,
    "--text-on-accent": labelOn(primary),
    "--accent-glow": `color-mix(in srgb, ${primary} 25%, transparent)`,
    "--leaf-bg": `color-mix(in srgb, ${primary} 10%, transparent)`,
  };

  const secondary = brand?.secondaryColorHex;
  if (secondary) {
    style["--card-gradient"] =
      `linear-gradient(135deg, ${primary} 0%, ${secondary} 100%)`;
  }

  return style as CSSProperties;
}

/**
 * Keyed by a host the visitor chose — every host reaches this app — so it is
 * bounded (FIFO past {@link CACHE_MAX}) and remembers a host with no brand
 * too, briefly: otherwise a scan of made-up hosts is one upstream call a page.
 */
const cache = new Map<string, { at: number; brand: Branding | null }>();

/** Unit test helper to reset in-memory state. */
export function clearBrandingCache(): void {
  cache.clear();
}

/**
 * Resolves the branding configuration for a target host:
 * 1. Queries the local memory cache.
 * 2. Fetches from the upstream tenant service if cache missed or expired.
 * 3. Never throws; a failure is the neutral look, remembered only briefly.
 */
export async function fetchBranding(
  host: string,
  origin: string = process.env.TENANT_SERVICE_ORIGIN || `https://${host}`,
): Promise<Branding | null> {
  // 1. Memory cache hit check
  const hit = cache.get(host);
  if (hit && Date.now() - hit.at < (hit.brand ? CACHE_MS : NEGATIVE_CACHE_MS)) {
    return hit.brand;
  }

  // 2. Fetch remote payload (never throws; returns null on error/timeout)
  const rawData = await getJsonAsHost(
    origin,
    `${TENANT_PUBLIC}/branding`,
    host,
    TIMEOUT_MS,
  );
  const brand = parseBranding(rawData);

  // 3. Remember it — a miss only for NEGATIVE_CACHE_MS. FIFO: past the cap
  // the oldest host goes, not the whole cache. A re-set moves the host last.
  cache.delete(host);
  if (cache.size >= CACHE_MAX) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(host, { at: Date.now(), brand });

  return brand;
}
