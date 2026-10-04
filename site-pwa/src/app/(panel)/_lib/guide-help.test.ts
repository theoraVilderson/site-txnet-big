import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { guideReadApi } from "@/lib/guide-api";
import { GUIDE_SECTION_ROUTES, osFromUserAgent, sectionOfPath, supportGuideQuery } from "./guide-help";
import { parseGuideMarkdown } from "./guide-markdown";

/**
 * Guides where they are placed (F-414-e). What breaks with nothing red anywhere:
 *  - **a section no page ever asks for**: shared-core's registry names one the
 *    panel has no route for, so an admin places a guide that never shows;
 *  - **the wrong section's help**: `/support/inbox/7` read as `support`, or a
 *    reseller's domains page as the reseller console;
 *  - **a link in a guide that runs script**: Markdown is a reseller's text,
 *    shown on every user's page.
 */
const REPO = join(__dirname, "../../../../..");
const SLOTS_SRC = readFileSync(join(REPO, "txnet-backend/shared-core/src/lib/guide/guide-slots.ts"), "utf8");
const sharedSections = [
  ...(SLOTS_SRC.match(/export const GUIDE_PANEL_SECTIONS = \[([\s\S]*?)\] as const/)?.[1] ?? "").matchAll(/'([^']+)'/g),
].map((m) => m[1]);

describe("a page asks for its own section's guides", () => {
  it("has a route for every panel section shared-core registers, and no other", () => {
    expect(sharedSections.length).toBeGreaterThan(20);
    expect(Object.keys(GUIDE_SECTION_ROUTES).sort()).toEqual([...sharedSections].sort());
  });

  it("picks the most specific section of a path", () => {
    expect(sectionOfPath("/")).toBe("home");
    expect(sectionOfPath("/services")).toBe("services");
    expect(sectionOfPath("/financial/deposit")).toBe("deposit");
    expect(sectionOfPath("/financial")).toBe("financial");
    expect(sectionOfPath("/support/inbox/7")).toBe("support_inbox");
    expect(sectionOfPath("/support/abc")).toBe("support");
    expect(sectionOfPath("/my-resellers/r1/domains")).toBe("reseller_domains");
    expect(sectionOfPath("/my-resellers/r1/catalog/translations")).toBe("reseller_catalog");
    expect(sectionOfPath("/my-resellers/r1")).toBe("my_resellers");
    expect(sectionOfPath("/wheel/settings")).toBe("wheel");
    expect(sectionOfPath("/guides/g1")).toBe("guides");
  });

  it("never matches on a prefix of a word", () => {
    expect(sectionOfPath("/shopping")).toBe("home");
  });
});

describe("the install guide starts on the visitor's own system", () => {
  it.each([
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36", "android"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)", "ios"],
    ["Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X)", "ios"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "windows"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)", "macos"],
    ["Mozilla/5.0 (X11; Linux x86_64)", "linux"],
    ["curl/8.0", null],
  ])("%s -> %s", (ua, os) => {
    expect(osFromUserAgent(ua)).toBe(os);
  });
});

describe("a guide's Markdown", () => {
  it("reads headings, lists, emphasis, code and links", () => {
    expect(parseGuideMarkdown("## Install\n\n- one **two**\n- `three`\n\n1. go [here](https://x.test/a)")).toEqual([
      { kind: "heading", level: 2, inlines: [{ t: "text", v: "Install" }] },
      {
        kind: "list",
        ordered: false,
        items: [[{ t: "text", v: "one " }, { t: "strong", c: [{ t: "text", v: "two" }] }], [{ t: "code", v: "three" }]],
      },
      { kind: "list", ordered: true, items: [[{ t: "text", v: "go " }, { t: "link", href: "https://x.test/a", c: [{ t: "text", v: "here" }] }]] },
    ]);
  });

  it("keeps a paragraph's line breaks", () => {
    expect(parseGuideMarkdown("a\nb")).toEqual([{ kind: "paragraph", lines: [[{ t: "text", v: "a" }], [{ t: "text", v: "b" }]] }]);
  });

  it("makes a link only of http(s) and this site's own paths", () => {
    const links = (md: string) =>
      parseGuideMarkdown(md).flatMap((b) => (b.kind === "paragraph" ? b.lines.flat() : [])).filter((n) => n.t === "link");
    expect(links("[a](javascript:alert(1))")).toEqual([]);
    expect(links("[a](data:text/html,x)")).toEqual([]);
    expect(links("[a](//evil.test)")).toEqual([]);
    expect(links("[a](/services)")).toHaveLength(1);
    expect(links("[a](http://x.test)")).toHaveLength(1);
  });

  it("leaves HTML as text", () => {
    expect(parseGuideMarkdown("<script>x</script>")).toEqual([{ kind: "paragraph", lines: [[{ t: "text", v: "<script>x</script>" }]] }]);
  });
});

describe("the reader", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks the public route for a slot on the panel, with no credential", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      seen.push({ url, auth: new Headers(init.headers).get("authorization") });
      return new Response(JSON.stringify({ success: true, data: { guides: [] } }), { status: 200 });
    });
    await guideReadApi.forSlot("route", "support_inbox");
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toMatch(/\/public\/tenant\/guides\?placement=route%3Asupport_inbox&surface=panel$/);
    expect(seen[0].auth).toBeNull();
  });

  it("searches on its own path, so no guide key can shadow it (F-414-j)", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify({ ok: true, data: { hits: [] } }), { status: 200 });
    });
    await guideReadApi.search("نصب اندروید");
    expect(seen[0]).toMatch(/\/public\/tenant\/guide-search\?q=%D9%86%D8%B5%D8%A8\+/);
    expect(seen[0]).toMatch(/&surface=panel$/);
  });

  it("asks for a support message's guides by any of its words (F-414-k)", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify({ ok: true, data: { hits: [] } }), { status: 200 });
    });
    await guideReadApi.suggest("vpn does not connect");
    expect(seen[0]).toMatch(/\/public\/tenant\/guide-search\?q=vpn\+does\+not\+connect&surface=panel&match=any$/);
  });
});

describe("the guides offered before a support conversation (F-414-k)", () => {
  it("are asked for by the subject and the start of the message, in the search's 100 characters", () => {
    expect(supportGuideQuery("", "")).toBe("");
    expect(supportGuideQuery(" ", "ok")).toBe("");
    expect(supportGuideQuery("Android", "  my app\n does not connect ")).toBe("Android my app does not connect");
    const long = supportGuideQuery("", "x ".repeat(80));
    expect(long.length).toBeLessThanOrEqual(100);
    expect(long.length).toBeGreaterThan(95);
  });
});
