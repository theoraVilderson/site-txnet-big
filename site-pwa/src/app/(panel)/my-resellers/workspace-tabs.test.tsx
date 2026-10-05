import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLocale } from "@/context/LocaleContext";
import { WorkspaceTabs } from "./_components/WorkspaceTabs";

/**
 * The reseller workspace's tab bar (UX-1-ad, `contract.ux.md` N8): under the
 * `PageHeader` on every `/my-resellers/:id/…` page, one link per section,
 * active by path. Before it, each section was reached from the console and
 * left by a "back to the console" link; switching sections took two taps.
 */

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
let pathname = "/my-resellers/r1";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

beforeEach(() => {
  vi.mocked(useLocale).mockReturnValue({ lang: "en", t: (_ns: string, key: string) => key } as unknown as ReturnType<typeof useLocale>);
});

const SECTIONS = [
  ["resellerOnboarding.tabs.overview", "/my-resellers/r1"],
  ["resellerOnboarding.tabs.users", "/my-resellers/r1/users"],
  ["resellerOnboarding.tabs.catalog", "/my-resellers/r1/catalog"],
  ["resellerOnboarding.tabs.domains", "/my-resellers/r1/domains"],
  ["resellerOnboarding.tabs.gateways", "/my-resellers/r1/gateways"],
  ["resellerOnboarding.tabs.bot", "/my-resellers/r1/bot"],
  ["resellerOnboarding.tabs.branding", "/my-resellers/r1/branding"],
] as const;

const current = () => screen.getAllByRole("link").filter((a) => a.getAttribute("aria-current") === "page");

describe("the workspace tab bar", () => {
  it("links every section of this reseller, in order, as a named nav", () => {
    render(<WorkspaceTabs id="r1" />);
    expect(screen.getByRole("navigation", { name: "resellerOnboarding.tabs.label" })).toBeInTheDocument();
    expect(screen.getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")])).toEqual(SECTIONS.map(([k, h]) => [k, h]));
  });

  it.each([
    ["/my-resellers/r1", "resellerOnboarding.tabs.overview"],
    ["/my-resellers/r1/domains", "resellerOnboarding.tabs.domains"],
    // A user's own page is still the users section; the overview is never active below itself.
    ["/my-resellers/r1/users/u9", "resellerOnboarding.tabs.users"],
    ["/my-resellers/r1/catalog/translations", "resellerOnboarding.tabs.catalog"],
  ])("marks one current page at %s", (path, label) => {
    pathname = path;
    render(<WorkspaceTabs id="r1" />);
    expect(current().map((a) => a.textContent)).toEqual([label]);
  });
});

/** Every workspace page draws it — through its view, or the surface's chrome. */
describe("every workspace page", () => {
  const WORKSPACE = join(__dirname, "[id]");
  const pages = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return pages(path);
      return name === "page.tsx" ? [path] : [];
    });
  const drawsTabs = (file: string, seen = new Set<string>()): boolean => {
    if (seen.has(file)) return false;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    if (source.includes("<WorkspaceTabs")) return true;
    const local = [...source.matchAll(/from "(\.{1,2}\/[^"]+)"/g)].map((m) => resolve(dirname(file), m[1]));
    return local.some((base) => [`${base}.tsx`, join(base, "index.tsx")].some((f) => statSync(f, { throwIfNoEntry: false })?.isFile() && drawsTabs(f, seen)));
  };

  it("has the tab bar", () => {
    const missing = pages(WORKSPACE)
      .filter((page) => !drawsTabs(page))
      .map((page) => relative(WORKSPACE, page));
    expect(missing).toEqual([]);
  });
});
