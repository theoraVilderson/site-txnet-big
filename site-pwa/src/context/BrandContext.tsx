"use client";

// The domain's brand, read once on the server (`lib/branding.ts`, F-066-v) and
// handed down here, so every screen shows the same one without a second read.
import { createContext, useContext } from "react";
import type { Branding } from "@/lib/branding";
import { useTheme } from "@/context/ThemeContext";

/**
 * What the page renders. `brand` is null when the host has no brand to give
 * (not a tenant's door, or tenant-service did not answer); `fallbackName` is
 * then the host itself — neutral, never the platform's or another tenant's name.
 */
export interface BrandValue {
  brand: Branding | null;
  fallbackName: string;
}

const BrandContext = createContext<BrandValue>({ brand: null, fallbackName: "" });

export function BrandProvider({
  value,
  children,
}: {
  value: BrandValue;
  children: React.ReactNode;
}) {
  return <BrandContext.Provider value={value}>{children}</BrandContext.Provider>;
}

/** The brand's name, and the logo for the current theme (the other one if only it exists). */
export function useBrand() {
  const { brand, fallbackName } = useContext(BrandContext);
  const { theme } = useTheme();
  const light = brand?.logoLightUrl ?? null;
  const dark = brand?.logoDarkUrl ?? null;
  return {
    name: brand?.brandName || fallbackName,
    logoUrl: theme === "light" ? (light ?? dark) : (dark ?? light),
  };
}
