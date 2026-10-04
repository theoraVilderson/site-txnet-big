import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { Me } from "@/lib/auth-api";
import type { GuideText } from "@/lib/guide-api";
import { guideFileUrl } from "@/lib/guide-api";
import { PANEL_GUIDES } from "@/lib/routes";
import { PANEL_MENU, menuHrefs, visibleMenu } from "../_lib/panel-menu";
import {
  GUIDE_BOT_SCREENS,
  GUIDE_OSES,
  GUIDE_PANEL_SECTIONS,
  GUIDE_SLOTS,
  REFUSAL_KEYS,
  emptyBlock,
  emptyPlacement,
  moveBlock,
  placementError,
  textsBody,
  textsForm,
  validateTexts,
} from "./_lib/guides";

/**
 * The guide settings page (F-414-d) over tenant-service's
 * `/api/guides/settings` (F-414-c). What breaks with nothing red anywhere:
 *  - **a slot the panel offers that tenant-service refuses** — the registry is
 *    copied from shared-core and held equal to it here;
 *  - **a refusal with no sentence** — every reason the controller maps has one,
 *    in both languages;
 *  - **a body the `.strict()` schema refuses** — empty languages and empty
 *    optional fields are dropped before the call, and the editor stops what the
 *    schema's bounds would.
 */
const REPO = join(__dirname, "../../../../..");
const SLOTS_SRC = readFileSync(join(REPO, "txnet-backend/shared-core/src/lib/guide/guide-slots.ts"), "utf8");
const CONTROLLER_SRC = readFileSync(join(REPO, "txnet-backend/tenant-service/src/app/guide/guide-admin.controller.ts"), "utf8");
const locale = (lang: string) => JSON.parse(readFileSync(join(REPO, `locales/frontend/langs/${lang}/common.json`), "utf8"));

/** The string items of `export const <name> = [ … ] as const` in shared-core. */
function tuple(name: string): string[] {
  const body = SLOTS_SRC.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`))?.[1] ?? "";
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

const lookup = (tree: unknown, key: string) => key.split(".").reduce<unknown>((n, k) => (n as Record<string, unknown> | undefined)?.[k], tree);

const ADMIN: Me = {
  userId: "u1",
  fullName: "Theora",
  role: { id: "r1", name: "Admin" },
  permissions: ["guide.manage"],
  tenant: { id: "t-res", type: "reseller", isOwner: false },
  email: null,
} as Me;

describe("the slot registry is shared-core's", () => {
  it("lists the same panel sections, bot screens and operating systems", () => {
    expect([...GUIDE_PANEL_SECTIONS]).toEqual(tuple("GUIDE_PANEL_SECTIONS"));
    expect([...GUIDE_BOT_SCREENS]).toEqual(tuple("GUIDE_BOT_SCREENS"));
    expect([...GUIDE_OSES]).toEqual(tuple("GUIDE_OSES"));
  });

  it("offers a route only on the panel and a bot screen only in the bot", () => {
    expect(GUIDE_SLOTS.route.surfaces).toEqual(["panel"]);
    expect(GUIDE_SLOTS.bot_screen.surfaces).toEqual(["bot"]);
    expect(placementError({ surface: "bot", targetKind: "route", targetRef: "home" })).not.toBeNull();
    expect(placementError({ surface: "any", targetKind: "os", targetRef: "beos" })).not.toBeNull();
    expect(placementError({ surface: "any", targetKind: "app", targetRef: "v2rayng" })).toBeNull();
    expect(placementError({ surface: "any", targetKind: "app", targetRef: "V2RayNG" })).not.toBeNull();
  });

  it("starts a new placement on a slot that is already valid for a closed kind", () => {
    for (const kind of ["os", "route", "bot_screen"] as const) expect(placementError(emptyPlacement(kind))).toBeNull();
  });
});

describe("refusals", () => {
  it("has a sentence for every reason the controller maps, in both languages", () => {
    const reasons = [...(CONTROLLER_SRC.match(/const STATUS[^{]*\{([\s\S]*?)\};/)?.[1] ?? "").matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
    expect(reasons.length).toBeGreaterThan(5);
    expect(Object.keys(REFUSAL_KEYS).sort()).toEqual(reasons.sort());
    for (const lang of ["fa", "en"]) {
      for (const key of Object.values(REFUSAL_KEYS)) expect(typeof lookup(locale(lang), key), `${lang} ${key}`).toBe("string");
    }
  });
});

describe("the texts form", () => {
  const fa = (over: Partial<GuideText> = {}): GuideText => ({ lang: "fa", title: "نصب", blocks: [{ type: "text", text: "یک" }], ...over });

  it("holds every language, and sends only the written ones, trimmed", () => {
    const form = textsForm([fa({ title: "  نصب  " })]);
    expect(form.map((t) => t.lang)).toEqual(["fa", "en"]);
    expect(textsBody(form)).toEqual([{ lang: "fa", title: "نصب", blocks: [{ type: "text", text: "یک" }] }]);
  });

  it("drops an empty caption, step image or callout title the strict schema would refuse", () => {
    const body = textsBody([
      fa({
        blocks: [
          { type: "image", file: "tenants/t/guides/g/a.png", alt: "a", caption: " " },
          { type: "steps", items: [{ text: "x", image: "" }] },
          { type: "callout", tone: "tip", title: "", text: "y" },
        ],
      }),
    ]);
    expect(body[0].blocks).toEqual([
      { type: "image", file: "tenants/t/guides/g/a.png", alt: "a" },
      { type: "steps", items: [{ text: "x" }] },
      { type: "callout", tone: "tip", text: "y" },
    ]);
  });

  it("stops what tenant-service would refuse", () => {
    expect(Object.keys(validateTexts(textsForm([])))).toEqual(["texts"]);
    expect(Object.keys(validateTexts([fa({ title: "" })]))).toEqual(["fa.title"]);
    expect(Object.keys(validateTexts([fa({ title: "x".repeat(121) })]))).toEqual(["fa.title"]);
    expect(Object.keys(validateTexts([fa({ blocks: [] })]))).toEqual(["fa.blocks"]);
    expect(Object.keys(validateTexts([fa({ blocks: [emptyBlock("image")] })]))).toEqual(["fa.blocks.0"]);
    expect(Object.keys(validateTexts([fa({ blocks: [emptyBlock("text"), { type: "text", text: "ok" }] })]))).toEqual(["fa.blocks.0"]);
    expect(validateTexts([fa()])).toEqual({});
  });

  it("moves a block and ignores a move past either end", () => {
    expect(moveBlock(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
    expect(moveBlock(["a", "b"], 0, -1)).toEqual(["a", "b"]);
  });
});

describe("the page", () => {
  it("is in the menu for guide.manage only", () => {
    expect(menuHrefs(visibleMenu(PANEL_MENU, ADMIN.permissions))).toContain(PANEL_GUIDES);
    expect(menuHrefs(visibleMenu(PANEL_MENU, []))).not.toContain(PANEL_GUIDES);
  });

  it("builds an image's address on this Host, by key", () => {
    expect(guideFileUrl("tenants/t-1/guides/g-1/a.png")).toBe("/api/public/tenant/files/tenants/t-1/guides/g-1/a.png");
  });
});
