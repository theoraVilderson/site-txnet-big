import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GiftCodeModal } from "./GiftCodeModal";
import { useLocale } from "@/context/LocaleContext";
import { billingApi } from "@/lib/billing-api";
import { ApiError } from "@/lib/api-error";

/**
 * The gift-code modal (F-093-g), and the one thing about it that has to be
 * true:
 *
 * > **A refusal is a refusal.** Nothing is credited, no success is shown, and
 * > no balance is adjusted anywhere on this side.
 *
 * That is a correction, not a precaution. The legacy modal
 * (`DiscountModal.tsx`) read `data.status === "nok"`, set its error — and then
 * fell through to the success path *unconditionally*, adding the refusal's
 * `data.amount` to a balance it kept in a client store. `amount` is undefined
 * on a refusal, so a user who typed a dead code was shown "gift activated" over
 * a wallet balance of `NaN`. Both halves of that are gone here: a refusal ends
 * the submit, and the balance the top bar shows is re-read from billing rather
 * than computed (`useWalletBalance`, `contract.shell.md` rule 1).
 *
 * The refusal *sentence* is billing's, already translated
 * (`contract.errors.md`) — five of them, one per reason, and the one below is
 * the one that matters most: a discount code typed into the gift box is told
 * where it actually belongs. This client keeps no copy of any of them.
 */

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
vi.mock("@/lib/billing-api", () => ({
  billingApi: { redeemGift: vi.fn() },
}));

const redeemGift = vi.mocked(billingApi.redeemGift);

/** The key back, so an assertion names the string the component asked for. */
const t = (_ns: string, key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}:${Object.values(vars).join(",")}` : key;

function open(props: Partial<Parameters<typeof GiftCodeModal>[0]> = {}) {
  const onClose = vi.fn();
  const onRedeemed = vi.fn();
  const utils = render(
    <GiftCodeModal open onClose={onClose} onRedeemed={onRedeemed} {...props} />,
  );
  return { ...utils, onClose, onRedeemed };
}

const codeBox = () => screen.getByRole("textbox");
const submit = () => screen.getByRole("button", { name: "wallet.gift.submit" });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useLocale).mockReturnValue({ lang: "en", t } as ReturnType<typeof useLocale>);
  redeemGift.mockResolvedValue({ code: "GIFT10", credited: "10.00", balance: "22.34" });
});

describe("a refused code", () => {
  it("shows billing's sentence and never a success", async () => {
    const user = userEvent.setup();
    redeemGift.mockRejectedValue(
      new ApiError("This is a discount code. Enter it when you top up your wallet.", {
        status: 409,
        ref: "a1b2c3d4e5",
      }),
    );
    const { onRedeemed } = open();

    await user.type(codeBox(), "SUMMER20");
    await user.click(submit());

    // The refusal, in the words billing already translated.
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This is a discount code. Enter it when you top up your wallet.",
    );
    // …and nothing that says it worked. Legacy showed both at once.
    expect(screen.queryByText("wallet.gift.successTitle")).not.toBeInTheDocument();
    expect(screen.queryByText(/wallet\.gift\.credited/)).not.toBeInTheDocument();
    // The one signal that would move a balance is never raised on a refusal.
    expect(onRedeemed).not.toHaveBeenCalled();
  });

  it("leaves the code in the box, so a typo is corrected rather than retyped", async () => {
    const user = userEvent.setup();
    redeemGift.mockRejectedValue(new ApiError("This gift code is not valid.", { status: 409 }));
    open();

    await user.type(codeBox(), "GIFT1O");
    await user.click(submit());

    await screen.findByRole("alert");
    expect(codeBox()).toHaveValue("GIFT1O");
    expect(submit()).toBeEnabled();
  });

  it("clears the previous refusal before the next attempt is answered", async () => {
    const user = userEvent.setup();
    redeemGift.mockRejectedValueOnce(new ApiError("This gift code has expired.", { status: 409 }));
    open();

    await user.type(codeBox(), "OLDCODE");
    await user.click(submit());
    await screen.findByRole("alert");

    await user.click(submit());

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });
});

describe("a redeemed code", () => {
  it("shows what billing credited, and hands the answer up rather than adding it", async () => {
    const user = userEvent.setup();
    const { onRedeemed } = open();

    await user.type(codeBox(), "gift10");
    await user.click(submit());

    expect(await screen.findByText("wallet.gift.successTitle")).toBeInTheDocument();
    // The figure is billing's `credited`, formatted — never a sum worked out here.
    expect(screen.getByText(/wallet\.gift\.credited:/)).toHaveTextContent("$10.00");
    expect(screen.getByText(/wallet\.gift\.newBalance:/)).toHaveTextContent("$22.34");
    // The top bar re-reads on this; it is not told an amount to add.
    expect(onRedeemed).toHaveBeenCalledTimes(1);
  });

  it("sends one code however it was typed — the padding and the case both go", async () => {
    const user = userEvent.setup();
    open();

    await user.type(codeBox(), "  gift10  ");
    await user.click(submit());

    // The box upper-cases as it is typed, so the user sees the form the coupon
    // is stored in. The service trims and upper-cases again regardless
    // (`normalizeCouponCodes`) — one code must not be two codes depending on
    // which box it was typed into.
    await waitFor(() => expect(redeemGift).toHaveBeenCalledWith("GIFT10"));
  });

  it("cannot be submitted twice — the route allows 10 tries per 15 minutes", async () => {
    const user = userEvent.setup();
    let answer: (v: never) => void = () => undefined;
    redeemGift.mockReturnValue(new Promise((resolve) => (answer = resolve as never)));
    open();

    await user.type(codeBox(), "GIFT10");
    await user.click(submit());

    expect(screen.getByRole("button", { name: "wallet.gift.submitting" })).toBeDisabled();
    answer({ code: "GIFT10", credited: "10.00", balance: "22.34" } as never);
    await screen.findByText("wallet.gift.successTitle");
    expect(redeemGift).toHaveBeenCalledTimes(1);
  });
});

describe("the box itself", () => {
  it("refuses to submit an empty code without spending a request", async () => {
    const user = userEvent.setup();
    open();

    expect(submit()).toBeDisabled();
    await user.type(codeBox(), "   ");
    expect(submit()).toBeDisabled();
    expect(redeemGift).not.toHaveBeenCalled();
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    const { onClose } = open();

    await user.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalled();
  });

  it("renders nothing at all while closed", () => {
    open({ open: false });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
