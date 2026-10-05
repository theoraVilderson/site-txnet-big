import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// UX-1-y, contract.ux.md K9: every question goes through useConfirm, and the
// five dangerous actions ask the person to type the object's name.
const SRC = join(__dirname, "..", "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const read = (path: string) => readFileSync(join(SRC, path), "utf8");

describe("confirm sites (K9)", () => {
  it("no source calls window.confirm", () => {
    const callers = sources(SRC)
      .filter((path) => /window\.confirm\s*\(/.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC, path));
    expect(callers).toEqual([]);
  });

  it.each([
    ["a gateway deleted", "app/(panel)/gateways/_components/GatewaysView.tsx"],
    ["categories holding products deleted", "app/(panel)/catalog/_components/CatalogView.tsx"],
    ["two or more configs retired", "app/(panel)/my-resellers/[id]/users/[userId]/_components/AdminConfigs.tsx"],
    ["a package's product unlisted", "app/(panel)/resellers/limits/_components/PackageProducts.tsx"],
    ["emergency support access", "app/(panel)/my-resellers/_components/PlatformAccessBanner.tsx"],
  ])("%s asks for the name typed", (_, path) => {
    expect(read(path)).toMatch(/\btypeToConfirm\b/);
  });
});
