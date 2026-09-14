// @vitest-environment node
import { signResultToken } from "../../../../../../txnet-backend/billing-service/src/app/payment/deposit/payment-result-token";
import { PAYMENT_FAILURE_KEYS } from "./payment-result";
import { readResultToken } from "./result-token";

/**
 * The page used to believe its query string, so `/payment/success?ref=X` typed
 * by hand showed a paid top-up that never happened. It now shows only an
 * outcome `billing` signed. Tokens here are minted by billing's own signer, so
 * a format change on either side fails this file.
 */
const SECRET = "k".repeat(32);
const NOW = 1_800_000_000_000;

const success = (referenceId: string | null, alreadyPaid = false) =>
  signResultToken({ kind: "success", referenceId, alreadyPaid }, SECRET, NOW);

describe("a token billing signed", () => {
  it("shows the success it carries", () => {
    expect(readResultToken(success("A123456789", true), SECRET, NOW)).toEqual({
      kind: "success",
      success: { reference: "A123456789", alreadyPaid: true },
    });
  });

  it("shows the failure it carries", () => {
    const token = signResultToken({ kind: "failed", code: "VERIFICATION_FAILED" }, SECRET, NOW);
    expect(readResultToken(token, SECRET, NOW)).toEqual({
      kind: "failed",
      failure: { code: "VERIFICATION_FAILED", messageKey: PAYMENT_FAILURE_KEYS.VERIFICATION_FAILED },
    });
  });
});

describe("anything else shows nothing", () => {
  it.each([undefined, "", "abc", "a.b.c", ["x", "y"]])("refuses %p", (raw) => {
    expect(readResultToken(raw as string | undefined, SECRET, NOW)).toBeNull();
  });

  it("refuses a token signed under another key", () => {
    expect(readResultToken(success("A1"), SECRET, NOW)).not.toBeNull();
    expect(readResultToken(success("A1"), "x".repeat(32), NOW)).toBeNull();
  });

  it("refuses a body edited after signing", () => {
    const [, mac] = success("A1").split(".");
    const forged = Buffer.from(JSON.stringify({ k: "s", r: "A999", e: NOW / 1000 + 900 })).toString("base64url");
    expect(readResultToken(`${forged}.${mac}`, SECRET, NOW)).toBeNull();
  });

  it("refuses an expired token", () => {
    expect(readResultToken(success("A1"), SECRET, NOW + 16 * 60 * 1000)).toBeNull();
  });

  it("refuses everything when no secret is configured", () => {
    expect(readResultToken(success("A1"), "", NOW)).toBeNull();
  });
});
