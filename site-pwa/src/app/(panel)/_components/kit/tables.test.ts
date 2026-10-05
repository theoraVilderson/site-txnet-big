import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every table in the panel is a kit `DataTable` (UX-1-h, `contract.ux.md`
 * K13), so every one has its phone layout: a `<table>` written by hand shows a
 * phone a strip it has to scroll sideways. The kit's own file is the one place
 * a `<table>` element is drawn.
 */

const PANEL = join(__dirname, "..", "..");
const KIT_TABLE = join(__dirname, "DataTable.tsx");

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
      .filter((path) => path !== KIT_TABLE)
      .filter((path) => /<table[\s>]/.test(readFileSync(path, "utf8")))
      .map((path) => relative(PANEL, path));
    expect(raw).toEqual([]);
  });
});
