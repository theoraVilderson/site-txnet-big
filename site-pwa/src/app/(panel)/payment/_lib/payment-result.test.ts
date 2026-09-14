import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  PAYMENT_FAILURE_KEYS,
  PAYMENT_RESULT_KEYS,
  readFailure,
  readSuccess,
} from "./payment-result";
import { PAYMENT_FAILED, PAYMENT_SUCCESS } from "@/lib/routes";
import { confettiBurst } from "./celebration";

/**
 * F-093-f. Two things break silently on these pages.
 *
 * The first is a code that stops matching: `billing`'s callback redirects here
 * with one of five names (`billing/contract.deposit.md`), and a name added or
 * renamed there without a key here is a payer reading a blank card at the end
 * of a payment. So the union is read out of the service's own source and
 * compared, rather than copied into a second list nothing checks.
 *
 * The second is a missing translation, which renders as a raw dot path. Every
 * key these pages can reach is resolved against the shipped `locales/frontend`
 * content in every language, the way `money.test.ts` does.
 */

const REPO = join(__dirname, "../../../../../..");
const LOCALES = join(REPO, "locales/frontend/langs");
const CALLBACK_SERVICE = join(
  REPO,
  "txnet-backend/billing-service/src/app/payment/deposit/deposit-callback.service.ts",
);
const CALLBACK_CONTROLLER = join(
  REPO,
  "txnet-backend/billing-service/src/app/payment/deposit/deposit-callback.controller.ts",
);

/** The `CallbackFailureCode` union, read from the service that sends the code. */
function codesBillingCanSend(): string[] {
  const source = readFileSync(CALLBACK_SERVICE, "utf8");
  const union = /export type CallbackFailureCode =([\s\S]*?);/.exec(source);
  if (!union) throw new Error("CallbackFailureCode is no longer a type alias — this test is stale");
  return [...union[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
}

function keysOf(lang: string): Set<string> {
  const out = new Set<string>();
  const walk = (prefix: string, value: unknown) => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const [k, child] of Object.entries(value)) walk(prefix ? `${prefix}.${k}` : k, child);
    } else if (typeof value === "string") {
      out.add(prefix);
    }
  };
  walk("", JSON.parse(readFileSync(join(LOCALES, lang, "common.json"), "utf8")));
  return out;
}

describe("the codes billing can send", () => {
  it("are exactly the ones these pages can explain", () => {
    expect([...codesBillingCanSend()].sort()).toEqual(Object.keys(PAYMENT_FAILURE_KEYS).sort());
  });
});

describe("the paths billing redirects to", () => {
  it("are the paths these pages are served at", () => {
    const source = readFileSync(CALLBACK_CONTROLLER, "utf8");
    const paths = /const RESULT_PATH = \{([^}]*)\}/.exec(source);
    if (!paths) throw new Error("RESULT_PATH is no longer a literal — this test is stale");
    expect(paths[1]).toContain(`'${PAYMENT_SUCCESS}'`);
    expect(paths[1]).toContain(`'${PAYMENT_FAILED}'`);
  });
});

describe("every key these pages can reach", () => {
  it.each(["en", "fa"])("resolves in %s", (lang) => {
    const shipped = keysOf(lang);
    const reachable = [...Object.values(PAYMENT_FAILURE_KEYS), ...flatten(PAYMENT_RESULT_KEYS)];
    const missing = reachable.filter((key) => !shipped.has(`paymentResult.${stripPrefix(key)}`));
    expect(missing).toEqual([]);
  });
});

/** The generated constants carry the key without its namespace (`paymentResult.x.y`). */
function stripPrefix(key: string): string {
  return key.replace(/^paymentResult\./, "");
}

function flatten(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") return Object.values(value).flatMap(flatten);
  return [];
}

describe("a failure the callback named", () => {
  it("is shown with its own sentence, and the code with it", () => {
    expect(readFailure("VERIFICATION_FAILED")).toEqual({
      code: "VERIFICATION_FAILED",
      messageKey: PAYMENT_FAILURE_KEYS.VERIFICATION_FAILED,
    });
  });

  it.each(["", undefined, "something-else", "INVALID_PARAMS "])(
    "falls back to one sentence and echoes nothing for %p",
    (raw) => {
      expect(readFailure(raw as string | undefined)).toEqual({
        code: null,
        messageKey: PAYMENT_RESULT_KEYS.failure.unknown,
      });
    },
  );

  it("takes the first value when the query string repeats the parameter", () => {
    expect(readFailure(["SYSTEM_ERROR", "INVALID_PARAMS"]).code).toBe("SYSTEM_ERROR");
  });
});

describe("a settled payment", () => {
  it("is a success even with no reference on the query string", () => {
    // Legacy read the reference as the verdict and printed "payment failed" for
    // a payment the bank had confirmed.
    expect(readSuccess(undefined, undefined)).toEqual({ reference: null, alreadyPaid: false });
  });

  it("carries the reference the bank returned", () => {
    expect(readSuccess("A00000000000000000000000000123456789", undefined).reference).toBe(
      "A00000000000000000000000000123456789",
    );
  });

  it.each(["  ", "not a reference", "x".repeat(65), "<script>"])(
    "refuses to print %p as a reference",
    (raw) => {
      expect(readSuccess(raw, undefined).reference).toBeNull();
    },
  );

  it("says already paid only for the flag billing actually sets", () => {
    expect(readSuccess("REF123", "1").alreadyPaid).toBe(true);
    expect(readSuccess("REF123", "true").alreadyPaid).toBe(false);
    expect(readSuccess("REF123", undefined).alreadyPaid).toBe(false);
  });
});

describe("the success confetti", () => {
  // Rendered on the server and hydrated in the browser, so a Math.random()
  // burst would be a hydration mismatch on the one page a payer celebrates on.
  it("is the same burst on every render", () => {
    expect(confettiBurst(24)).toEqual(confettiBurst(24));
    expect(confettiBurst(24)).toHaveLength(24);
  });

  it("flies outward in every direction, within the card", () => {
    const burst = confettiBurst(24);
    expect(burst.some((p) => p.dx < 0) && burst.some((p) => p.dx > 0)).toBe(true);
    expect(burst.some((p) => p.dy < 0) && burst.some((p) => p.dy > 0)).toBe(true);
    for (const p of burst) {
      const distance = Math.hypot(p.dx, p.dy);
      expect(distance).toBeGreaterThanOrEqual(70);
      expect(distance).toBeLessThanOrEqual(170);
    }
  });

  it("is painted with theme tokens only — never gold", () => {
    for (const p of confettiBurst(24)) {
      expect(p.color).toMatch(/^var\(--[a-z-]+\)$/);
      expect(p.color).not.toContain("gold");
    }
  });
});
