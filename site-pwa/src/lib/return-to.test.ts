import { AUTH_LOGIN, PANEL_HOME } from "@/lib/routes";

import {
  RETURN_TO_KEY,
  clearReturnTo,
  consumeReturnTo,
  isSafeReturnPath,
  rememberReturnTo,
} from "./return-to";

/**
 * F-093-i, ADR-0042. Two things break silently here, and one of them is a
 * security bug rather than a bug.
 *
 * **The destination is attacker-shaped input.** It is read back and handed to
 * `router.replace` on the sign-in screen, which is the page a user is most
 * willing to trust — so anything that can leave this origin has to be refused
 * rather than sanitised: a scheme, a host, a protocol-relative `//evil.com`, a
 * backslash the browser folds into a slash. Each of those has its own case
 * below, because each is a separate way a validator gets written wrongly.
 *
 * **A destination that outlives its intent sends the wrong user somewhere.**
 * Reading it consumes it, and a deliberate sign-out clears it — otherwise the
 * next person to sign in on that tab lands on the previous one's payment.
 *
 * `sessionStorage` can throw or be empty on a perfectly ordinary browser
 * (private windows, blocked site data), so every path here has to survive it
 * being unavailable; that is the last case.
 */

describe("isSafeReturnPath", () => {
  it("accepts a relative path, with query and hash", () => {
    expect(isSafeReturnPath("/payment/success?ref=900900900")).toBe(true);
    expect(isSafeReturnPath("/financial#top")).toBe(true);
    expect(isSafeReturnPath("/")).toBe(true);
  });

  it("refuses anything that can leave this origin", () => {
    expect(isSafeReturnPath("//evil.example")).toBe(false);
    expect(isSafeReturnPath("https://evil.example/x")).toBe(false);
    expect(isSafeReturnPath("http://evil.example")).toBe(false);
    expect(isSafeReturnPath("javascript:alert(1)")).toBe(false);
    expect(isSafeReturnPath("/\\evil.example")).toBe(false);
    expect(isSafeReturnPath("\\/evil.example")).toBe(false);
  });

  it("refuses a path that is not a path", () => {
    expect(isSafeReturnPath("financial")).toBe(false);
    expect(isSafeReturnPath("")).toBe(false);
    expect(isSafeReturnPath("/x\ny")).toBe(false);
  });

  it("refuses the auth screens themselves, which would be a loop", () => {
    expect(isSafeReturnPath(AUTH_LOGIN)).toBe(false);
    expect(isSafeReturnPath("/auth/register?x=1")).toBe(false);
  });
});

describe("remember / consume", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("gives back what it was given, once", () => {
    rememberReturnTo("/payment/success?ref=900900900");

    expect(consumeReturnTo()).toBe("/payment/success?ref=900900900");
    // Consumed: a second sign-in on this tab is not the same intent.
    expect(consumeReturnTo()).toBe(PANEL_HOME);
  });

  it("stores nothing a validator would refuse", () => {
    rememberReturnTo("https://evil.example/x");

    expect(window.sessionStorage.getItem(RETURN_TO_KEY)).toBeNull();
    expect(consumeReturnTo()).toBe(PANEL_HOME);
  });

  it("refuses on the way out as well as on the way in", () => {
    // Whatever put this there, it is not going to `router.replace`.
    window.sessionStorage.setItem(RETURN_TO_KEY, "//evil.example");

    expect(consumeReturnTo()).toBe(PANEL_HOME);
    expect(window.sessionStorage.getItem(RETURN_TO_KEY)).toBeNull();
  });

  it("is cleared by a deliberate sign-out", () => {
    rememberReturnTo("/financial");

    clearReturnTo();

    expect(consumeReturnTo()).toBe(PANEL_HOME);
  });

  it("survives storage it cannot use", () => {
    const broken = () => {
      throw new Error("blocked");
    };
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(broken);
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(broken);

    expect(() => rememberReturnTo("/financial")).not.toThrow();
    expect(consumeReturnTo()).toBe(PANEL_HOME);

    get.mockRestore();
    set.mockRestore();
  });
});
