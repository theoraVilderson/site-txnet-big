import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PANEL_MY_RESELLERS, myResellerBotPath } from "@/lib/routes";
import { resellerBotApiPath, resellerBotRetirePath } from "@/lib/auth-api";
import {
  BOT_PLATFORMS,
  BOT_REFUSAL_KEYS,
  BOT_STATUS_KEYS,
  botRefusalKey,
  botToken,
  connectBody,
  isPrimaryTaken,
} from "./_lib/bots";
import { stepHref } from "./_lib/onboarding";

/**
 * A reseller's bot, `/my-resellers/[id]/bot` (F-066-w6, ADR-0064 (4)) — the
 * screen the onboarding console's bot step is finished on, over the routes
 * F-066-w5 built. What breaks here with nothing red anywhere else is the seam
 * between the screen and those routes:
 *
 *  - **a call that leaves out the reseller.** The owner signs in to the
 *    platform owner's tenant (ADR-0059), so a path built without
 *    `/tenants/:id` would connect a bot to the **platform**, and answer 201
 *    doing it;
 *  - **a bot named by its webhook path.** The path is a credential (F-323,
 *    ADR-0009) and is not on the wire at all; a retire names the `@handle`;
 *  - **a body the `.strict()` schema refuses** — a `tenantId` the session
 *    would add, or a `role`: every bot connected here is the `primary`;
 *  - **a refusal with no sentence**, read from the controller's own exhaustive
 *    `STATUS` map, so a reason added there fails here instead of reaching a
 *    reseller's owner as a blank line;
 *  - **the console's bot step linking nothing**, which is what it did until
 *    this row.
 */
const REPO = join(__dirname, "../../../../..");
const CONTROLLER = "txnet-backend/auth-service/src/app/automation/reseller-bot.controller.ts";
const SERVICE = "txnet-backend/auth-service/src/app/automation/reseller-bot.service.ts";
const SCHEMA = "txnet-backend/auth-service/src/app/automation/reseller-bot.schema.ts";
const PLATFORMS = "txnet-backend/messenger/src/lib/bot-platform.ts";
const PRISMA = "txnet-backend/prisma/domains/automation.prisma";

const source = (rel: string) => readFileSync(join(REPO, rel), "utf8");

describe("the routes the screen calls", () => {
  it("names the reseller in the path, never the session's tenant", () => {
    expect(resellerBotApiPath("t-1")).toBe("/auth/tenants/t-1/bots");
    expect(resellerBotApiPath("a b/c")).toBe("/auth/tenants/a%20b%2Fc/bots");
  });

  it("retires a bot by its platform and @handle, each escaped", () => {
    expect(resellerBotRetirePath("t-1", "telegram", "my_bot")).toBe("/auth/tenants/t-1/bots/telegram/my_bot");
    expect(resellerBotRetirePath("t-1", "bale", "a/b")).toBe("/auth/tenants/t-1/bots/bale/a%2Fb");
  });

  it("is the path the controller serves", () => {
    expect(source(CONTROLLER)).toContain("@Controller('auth/tenants/:tenantId/bots')");
    expect(source(CONTROLLER)).toContain("@Delete(':platform/:botUsername')");
  });
});

describe("the connect body", () => {
  it("carries the platform and the token and nothing else — the schema is .strict()", () => {
    expect(connectBody("telegram", "  123:ABC  ")).toEqual({ platform: "telegram", token: "123:ABC" });
    expect(Object.keys(connectBody("bale", "t"))).toEqual(["platform", "token"]);
  });

  it("holds a token the schema would refuse off the wire", () => {
    expect(botToken("   ")).toBeNull();
    expect(botToken("x".repeat(201))).toBeNull();
    expect(botToken("  123:ABC ")).toBe("123:ABC");
    // 1..200 after trim, and nothing about the shape: both messengers have
    // changed their token format, so the only judge is the messenger's answer.
    const schema = source(SCHEMA);
    expect(schema).toContain("z.string().trim().min(1).max(200)");
    expect(schema).toContain(".strict()");
  });

  it("never sends a @handle: it comes from getMe", () => {
    expect(JSON.stringify(connectBody("telegram", "t"))).not.toContain("botUsername");
  });
});

describe("what the screen may show", () => {
  it("offers exactly the platforms messenger knows (C-09)", () => {
    const declared = source(PLATFORMS).match(/BOT_PLATFORMS: readonly BotPlatform\[\] = \[([^\]]*)\]/)?.[1];
    const names = [...(declared ?? "").matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    expect([...BOT_PLATFORMS]).toEqual(names);
  });

  it("has a label for every status a bot row can be in", () => {
    const block = source(PRISMA).match(/enum BotIntegrationStatus \{([^}]*)\}/)?.[1] ?? "";
    const statuses = block
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^[a-z]+$/.test(l));
    expect(statuses.length).toBeGreaterThan(0);
    expect(Object.keys(BOT_STATUS_KEYS).sort()).toEqual([...statuses].sort());
  });

  it("carries no credential: the view is {id, platform, botUsername, role, status}", () => {
    const view = source(SERVICE).match(/export interface ResellerBotView \{([^}]*)\}/)?.[1] ?? "";
    const fields = [...view.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
    expect(fields.sort()).toEqual(["botUsername", "id", "platform", "role", "status"]);
    for (const secret of ["token", "webhookPath", "credentialRef", "webhookSecret"]) {
      expect(view).not.toContain(secret);
    }
  });
});

describe("refusals", () => {
  it("has a sentence for every reason the controller answers with", () => {
    const map = source(CONTROLLER).match(/const STATUS: Record<ResellerBotRejection[^>]*> = \{([\s\S]*?)\n\};/)?.[1] ?? "";
    const reasons = [...map.matchAll(/^\s*(\w+):\s*\d{3},/gm)].map((m) => m[1]);
    expect(reasons.length).toBeGreaterThan(0);
    expect(Object.keys(BOT_REFUSAL_KEYS).sort()).toEqual([...reasons].sort());
  });

  it("reads the reason off the answer, and says nothing about one it does not know", () => {
    expect(botRefusalKey({ reason: "invalid_token" })).toBe(BOT_REFUSAL_KEYS.invalid_token);
    expect(botRefusalKey({ reason: "something_new" })).toBeNull();
    expect(botRefusalKey(new Error("offline"))).toBeNull();
    expect(botRefusalKey(null)).toBeNull();
  });

  it("knows a second primary on the same platform is refused, so the form does not offer one", () => {
    const bots = [{ id: "1", platform: "telegram", botUsername: "a", role: "primary", status: "active" } as const];
    expect(isPrimaryTaken(bots, "telegram")).toBe(true);
    expect(isPrimaryTaken(bots, "bale")).toBe(false);
    expect(isPrimaryTaken([], "telegram")).toBe(false);
  });
});

describe("the console's bot step", () => {
  it("links this screen, under the workspace and not the ambient one", () => {
    expect(myResellerBotPath("t-1")).toBe(`${PANEL_MY_RESELLERS}/t-1/bot`);
    expect(stepHref("bot", "t-1")).toBe(myResellerBotPath("t-1"));
  });
});
