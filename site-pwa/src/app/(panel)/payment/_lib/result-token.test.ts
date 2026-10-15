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
      success: { reference: "A123456789", alreadyPaid: true, botLink: null },
    });
  });

  it("shows the failure it carries", () => {
    const token = signResultToken({ kind: "failed", code: "VERIFICATION_FAILED" }, SECRET, NOW);
    expect(readResultToken(token, SECRET, NOW)).toEqual({
      kind: "failed",
      failure: { code: "VERIFICATION_FAILED", messageKey: PAYMENT_FAILURE_KEYS.VERIFICATION_FAILED, botLink: null },
    });
  });
});

// F-093-u: a top-up started in a bot offers the way back to that bot.
describe("the bot a payer came from", () => {
  const link = "https://t.me/txnet_bot?start=paid";

  it("is offered on a success and on a failure", () => {
    const ok = signResultToken({ kind: "success", referenceId: "A1", alreadyPaid: false, returnBotLink: link }, SECRET, NOW);
    const failed = signResultToken({ kind: "failed", code: "SYSTEM_ERROR", returnBotLink: link }, SECRET, NOW);
    expect(readResultToken(ok, SECRET, NOW)).toMatchObject({ kind: "success", success: { botLink: link } });
    expect(readResultToken(failed, SECRET, NOW)).toMatchObject({ kind: "failed", failure: { botLink: link } });
  });

  it("is absent from a panel top-up", () => {
    expect(readResultToken(success("A1"), SECRET, NOW)).toMatchObject({ success: { botLink: null } });
  });
});

describe("a verifying payment (F-093-l)", () => {
  const PAYMENT = "77777777-7777-4777-8777-777777777777";

  it("carries the payment the pending page polls", () => {
    const token = signResultToken({ kind: "verifying", paymentId: PAYMENT }, SECRET, NOW);
    expect(readResultToken(token, SECRET, NOW)).toEqual({ kind: "verifying", paymentId: PAYMENT });
  });

  it("refuses a payment id that is not a uuid, even signed", () => {
    const token = signResultToken({ kind: "verifying", paymentId: "../../wallet" }, SECRET, NOW);
    expect(readResultToken(token, SECRET, NOW)).toBeNull();
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
