import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PANEL_MY_RESELLERS, myResellerBrandingPath } from "@/lib/routes";
import {
  BRANDING_REFUSAL_KEYS,
  LINE_NAME_PLACEHOLDERS,
  LINE_NAME_PLACEHOLDER_KEYS,
  LINE_NAME_PROBLEM_KEYS,
  MAX_LINE_NAME_TEMPLATE_LENGTH,
  brandingRefusalKey,
  insertPlaceholder,
  templateToSend,
} from "./_lib/branding";

/**
 * A reseller's brand settings, `/my-resellers/[id]/branding` (F-307-k,
 * ADR-0089 rule 4): the default name of a config line in a buyer's app.
 * What breaks with nothing red anywhere:
 *  - **a problem, a placeholder or a refusal with no sentence.** Each is read
 *    out of shared-core's own source, so a value added there fails here
 *    instead of reaching an owner as a blank line, or a placeholder the
 *    service refuses being offered as a button;
 *  - **a template sent as typed** — with its spaces, or `""` where the
 *    platform default is `null`;
 *  - **a link to a path Next does not serve.**
 */
const REPO = join(__dirname, "../../../../..");
const read = (path: string) => readFileSync(join(REPO, "txnet-backend", path), "utf8");
const TEMPLATE = "shared-core/src/lib/tenant/line-name-template.ts";

function tupleOf(file: string, name: string): string[] {
  const tuple = new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const`).exec(read(file));
  if (!tuple) throw new Error(`${name} is no longer an as-const tuple — this test is stale`);
  return [...tuple[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe("what the template can be", () => {
  it("has a sentence for every problem the preview answers", () => {
    expect(Object.keys(LINE_NAME_PROBLEM_KEYS).sort()).toEqual(tupleOf(TEMPLATE, "LINE_NAME_TEMPLATE_PROBLEMS").sort());
  });

  it("offers exactly the placeholders the service accepts, each with a label", () => {
    expect([...LINE_NAME_PLACEHOLDERS]).toEqual(tupleOf(TEMPLATE, "LINE_NAME_PLACEHOLDERS"));
    expect(Object.keys(LINE_NAME_PLACEHOLDER_KEYS).sort()).toEqual([...LINE_NAME_PLACEHOLDERS].sort());
  });

  it("holds the service's cap", () => {
    expect(read(TEMPLATE)).toContain(`MAX_LINE_NAME_TEMPLATE_LENGTH = ${MAX_LINE_NAME_TEMPLATE_LENGTH};`);
  });

  it("sends a template trimmed, and an empty one as the platform default", () => {
    expect(templateToSend("  {brand} · {region} ")).toBe("{brand} · {region}");
    expect(templateToSend("   ")).toBeNull();
  });

  it("puts a placeholder where the caret was", () => {
    expect(insertPlaceholder("Nova ", 5, "region")).toEqual({ value: "Nova {region}", caret: 13 });
    expect(insertPlaceholder(" VPN", 0, "brand")).toEqual({ value: "{brand} VPN", caret: 7 });
    expect(insertPlaceholder("x", 99, "brand")).toEqual({ value: "x{brand}", caret: 8 });
  });
});

describe("what the routes can refuse", () => {
  it("has a sentence for every admission refusal", () => {
    const union = /export type ResellerAccessRejection =([\s\S]*?);/.exec(read("shared-core/src/lib/tenant/reseller-access.ts"));
    const reasons = [...(union?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(Object.keys(BRANDING_REFUSAL_KEYS).sort()).toEqual(reasons.sort());
    expect(brandingRefusalKey({ reason: "reseller_suspended" })).toBe(BRANDING_REFUSAL_KEYS.reseller_suspended);
    expect(brandingRefusalKey(new Error("offline"))).toBeNull();
  });
});

describe("where it lives", () => {
  it("links to a page Next serves", () => {
    expect(myResellerBrandingPath("a b")).toBe(`${PANEL_MY_RESELLERS}/a%20b/branding`);
    expect(existsSync(join(__dirname, "[id]/branding/page.tsx"))).toBe(true);
  });
});
