import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every table in the panel is a kit `DataTable` (UX-1-h, `contract.ux.md`
 * K13), so every one has its phone layout: a `<table>` written by hand shows a
 * phone a strip it has to scroll sideways. The kit draws `<table>` in two
 * places only: `DataTable`, and the cohort heatmap — a grid read across and
 * down, which a card per row would break; it scrolls inside its card and says
 * every cell in words (F-1004-b, panel-web `contract.analytics.md` rule 12).
 */

const PANEL = join(__dirname, "..", "..");
const KIT_TABLES = [join(__dirname, "DataTable.tsx"), join(__dirname, "charts", "CohortGrid.tsx")];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sources(path);
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [path] : [];
  });
}

describe("panel tables", () => {
  it("are all drawn by the kit DataTable", () => {
    const raw = sources(PANEL)
      .filter((path) => !KIT_TABLES.includes(path))
      .filter((path) => /<table[\s>]/.test(readFileSync(path, "utf8")))
      .map((path) => relative(PANEL, path));
    expect(raw).toEqual([]);
  });
});
