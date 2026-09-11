import { readFileSync } from "node:fs";
import { join } from "node:path";

import { AUTH_KEY_MAP, OTP_FAILURE_STRINGS, otpFailureString } from "./translations";

/**
 * F-082. The generated constants make a *renamed* key a compile error. They
 * cannot say the key has a sentence in every language the panel ships — and
 * before this file nothing in the repo read `locales/frontend` at all, so a
 * missing translation rendered as a raw dot path on the login screen with
 * every suite green.
 */

const LOCALES = join(__dirname, "../../../../../../locales/frontend/langs");

function flatten(prefix: string, value: unknown, out: Map<string, string>): void {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, child] of Object.entries(value)) flatten(prefix ? `${prefix}.${k}` : k, child, out);
  } else if (typeof value === "string") {
    out.set(prefix, value);
  }
}

function authNamespace(lang: string): Map<string, string> {
  const out = new Map<string, string>();
  flatten("", JSON.parse(readFileSync(join(LOCALES, lang, "auth.json"), "utf8")), out);
  return out;
}

describe.each(["fa", "en"])("AUTH_KEY_MAP in %s", (lang) => {
  const auth = authNamespace(lang);

  it.each(Object.entries(AUTH_KEY_MAP))("%s resolves to a non-empty sentence", (_name, path) => {
    expect(auth.get(path)?.trim()).toBeTruthy();
  });
});

describe("the OTP failure table", () => {
  it("maps every backend failure key onto a component string that exists", () => {
    for (const component of Object.values(OTP_FAILURE_STRINGS)) {
      expect(Object.keys(AUTH_KEY_MAP)).toContain(component);
    }
  });

  it("answers the general line for a key it has no row for", () => {
    // Still a failed send — the user must see something, never nothing.
    expect(otpFailureString("otp.somethingNew")).toBe("otpDeliveryFailed");
    expect(otpFailureString(null)).toBe("otpDeliveryFailed");
  });

  it("never resolves a key off the object prototype", () => {
    // The key arrives off a socket, so it is whatever the wire said.
    expect(otpFailureString("constructor")).toBe("otpDeliveryFailed");
    expect(otpFailureString("__proto__")).toBe("otpDeliveryFailed");
  });

  it("resolves the three failures the worker actually sends", () => {
    expect(otpFailureString("otp.smsNotConfigured")).toBe("otpDeliverySmsNotConfigured");
    expect(otpFailureString("otp.deliveryUnavailable")).toBe("otpDeliveryUnavailable");
    expect(otpFailureString("otp.deliveryFailed")).toBe("otpDeliveryFailed");
  });
});
