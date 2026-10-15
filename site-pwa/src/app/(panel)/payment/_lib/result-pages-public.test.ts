// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The bank's return lands a payer on `/payment/success` or `/payment/failed`
 * (2026-10-15). A payer who started in a bot has no panel session in that
 * browser, and every page under `(panel)` sends such a visitor to the login
 * page — before they could tap "back to the bot". The two pages show only what
 * billing signed into `?t=` (rule 10), so they need no session: they live in
 * their own route group, outside `(panel)`'s `PanelSessionProvider`.
 */
const APP = join(__dirname, "../../..");

describe("the result pages", () => {
  it.each(["success", "failed"])("/payment/%s is outside the panel's signed-in layout", (page) => {
    expect(existsSync(join(APP, "(payment-result)/payment", page, "page.tsx"))).toBe(true);
    expect(existsSync(join(APP, "(panel)/payment", page, "page.tsx"))).toBe(false);
  });

  it("and its layout signs nobody in or out", () => {
    const layout = join(APP, "(payment-result)/layout.tsx");
    expect(existsSync(layout) ? readFileSync(layout, "utf8") : "").not.toMatch(/PanelSession|AUTH_LOGIN/);
  });
});
