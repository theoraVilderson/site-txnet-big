import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { catalogApi } from "@/lib/catalog-api";
import { packageTranslationsApi } from "@/lib/tenant-api";
import { PANEL_RESELLER_PACKAGES } from "@/lib/routes";
import { usePanelSession } from "../_context/PanelSessionContext";
import { PackageTranslationsView } from "./packages/_components/PackageTranslationsView";

/**
 * PK-1-h (ADR-0154 (6)): the packages' drafts are reviewed on the catalog's
 * own `TranslationsView`, through a review surface whose api is
 * tenant-service's. What breaks with nothing red: the view falls back to the
 * catalog surface, so the page lists — and publishes — the catalog's drafts
 * under a "package translations" heading, and the packages' never appear.
 */

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
vi.mock("../_context/PanelSessionContext", () => ({ usePanelSession: vi.fn() }));
vi.mock("@/lib/catalog-api", async (actual) => {
  const real = await actual<typeof import("@/lib/catalog-api")>();
  return { ...real, catalogApi: { ...real.catalogApi, translations: vi.fn(async () => []) } };
});
vi.mock("@/lib/tenant-api", async (actual) => {
  const real = await actual<typeof import("@/lib/tenant-api")>();
  return { ...real, packageTranslationsApi: { ...real.packageTranslationsApi, translations: vi.fn(async () => []) } };
});

const K = FrontendI18nKeys.common.resellers.packages.translations;
const OWNER = { tenant: { id: "t-platform", type: "platform_owner" }, permissions: ["platform.tenant.manage"] };

beforeEach(() => {
  vi.mocked(useLocale).mockReturnValue({ lang: "en", isRtl: false, availableLocales: [], t: (_ns: string, key: string) => key } as unknown as ReturnType<typeof useLocale>);
  vi.mocked(usePanelSession).mockReturnValue({ me: OWNER, isLoading: false } as unknown as ReturnType<typeof usePanelSession>);
});

describe("the package translations page", () => {
  it("reads tenant-service's drafts, never the catalog's, under the packages' headings", async () => {
    render(<PackageTranslationsView />);
    await waitFor(() => expect(packageTranslationsApi.translations).toHaveBeenCalled());
    expect(catalogApi.translations).not.toHaveBeenCalled();
    expect(screen.getAllByText(K.title).length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: K.back }).getAttribute("href")).toBe(PANEL_RESELLER_PACKAGES);
  });
});
