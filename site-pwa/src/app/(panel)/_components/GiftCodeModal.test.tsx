import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

/**
 * Above vitest's 5s default, for the machine and not for the code.
 *
 * These cases drive a real animated dialog: framer-motion springs, an `auto`
 * height, an exit animation to wait out. Alone the slowest is ~1.7s, but this
 * file runs beside 19 others and the workspace oversubscribes the box — the
 * same contention `docs/CODE-LAYOUT.md` warns about, which arrives as a
 * *timeout* and reads exactly like a broken assertion. The animation was made
 * cheap first (`contract.gift-code.md` rule 6 has that measurement); this is the
 * headroom left over, so a slow machine cannot turn a passing suite red.
 */
vi.setConfig({ testTimeout: 15_000 });

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
vi.mock("@/lib/billing-api", () => ({
  billingApi: { redeemGift: vi.fn(), rotateGrantToken: vi.fn() },
}));

const redeemGift = vi.mocked(billingApi.redeemGift);
const rotateGrantToken = vi.mocked(billingApi.rotateGrantToken);

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

/**
 * Put a code in the box in one change rather than eight keystrokes.
 *
 * It runs the same `onChange` the user does — the case and the padding are
 * handled there either way. What it skips is seven re-renders of an animated
 * dialog, which is not what any of these cases is about and which cost enough
 * to matter: typing character by character put this file at 4.2s against
 * vitest's 5s ceiling. The one case that *is* about how typing transforms a
 * code still types (`contract.gift-code.md` rule 6 has the measurement).
 */
function fillCode(value: string) {
  fireEvent.change(codeBox(), { target: { value } });
}

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

    fillCode("SUMMER20");
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

    fillCode("GIFT1O");
    await user.click(submit());

    await screen.findByRole("alert");
    expect(codeBox()).toHaveValue("GIFT1O");
    expect(submit()).toBeEnabled();
  });

  it("clears the previous refusal before the next attempt is answered", async () => {
    const user = userEvent.setup();
    redeemGift.mockRejectedValueOnce(new ApiError("This gift code has expired.", { status: 409 }));
    open();

    fillCode("OLDCODE");
    await user.click(submit());
    await screen.findByRole("alert");

    await user.click(submit());

    // Behind the alert's exit animation, so this waits on a render, not a call.
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument(), {
      timeout: 5_000,
    });
  });
});

describe("a redeemed code", () => {
  it("shows what billing credited, and hands the answer up rather than adding it", async () => {
    const user = userEvent.setup();
    const { onRedeemed } = open();

    fillCode("gift10");
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

    fillCode("GIFT10");
    await user.click(submit());

    expect(screen.getByRole("button", { name: "wallet.gift.submitting" })).toBeDisabled();
    answer({ code: "GIFT10", credited: "10.00", balance: "22.34" } as never);
    await screen.findByText("wallet.gift.successTitle");
    expect(redeemGift).toHaveBeenCalledTimes(1);
  });
});

/**
 * A free-service code (F-502-l-c, D-35): billing answers a Grant and its
 * subscription key instead of a credit. The key is shown this once — billing
 * keeps only its hash — so the screen says so, and no money figure appears.
 */
describe("a free-service code", () => {
  it("shows the activated service and its key once, and no credit", async () => {
    const user = userEvent.setup();
    redeemGift.mockResolvedValue({
      kind: "free_grant",
      code: "FREEVPN",
      grant: { id: "g1", variantId: "v1", startsAt: "2026-09-15T00:00:00.000Z", endsAt: "2026-10-15T00:00:00.000Z", featureKeys: ["vpn.access"] },
      subscriptionKey: "KEY-3kq9-once",
    });
    const { onRedeemed } = open();

    fillCode("FREEVPN");
    await user.click(submit());

    expect(await screen.findByText("wallet.gift.serviceTitle")).toBeInTheDocument();
    expect(screen.getByText("KEY-3kq9-once")).toBeInTheDocument();
    expect(screen.getByText("wallet.gift.keyOnce")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "wallet.gift.copy" })).toBeInTheDocument();
    expect(screen.queryByText(/wallet\.gift\.credited/)).not.toBeInTheDocument();
    expect(screen.queryByText(/wallet\.gift\.newBalance/)).not.toBeInTheDocument();
    expect(onRedeemed).toHaveBeenCalledTimes(1);
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

  it("renders outside its caller's subtree, not under it", () => {
    // The portal is load-bearing, not tidiness. Its caller sits in a top bar
    // carrying `backdrop-blur-xl`, and an element with a `backdrop-filter` is
    // the containing block for every fixed-position descendant — so `fixed
    // inset-0` rendered in place meant that 64px bar, and the modal came up
    // invisible. The bar's `z-20` caps the stacking order the same way. jsdom
    // has neither of those semantics, so this is the part of it a spec can
    // hold: the dialog is a child of `body`, not of whatever mounted it.
    const { container } = render(
      <div data-testid="caller">
        <GiftCodeModal open onClose={vi.fn()} />
      </div>,
    );

    const dialog = screen.getByRole("dialog");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.contains(dialog)).toBe(true);
  });

  it("locks the page behind it, and gives the scroll back on close", async () => {
    const { rerender, onClose } = open();
    expect(document.body.style.overflow).toBe("hidden");

    rerender(<GiftCodeModal open={false} onClose={onClose} />);

    // The dialog animates out, so the lock lifts when it unmounts rather than
    // on the prop change — a page left unscrollable is the failure that matters.
    await waitFor(() => expect(document.body.style.overflow).not.toBe("hidden"), {
      timeout: 5_000,
    });
  });
});

/**
 * The key is shown once and billing keeps only its hash (F-502-m, D-35), so a
 * dismissal that was not meant is not a closed modal — it is a key the user
 * never copied.
 *
 * `Escape` and the backdrop are the two ways to close a dialog *without
 * deciding to*, and since F-502-q they neither close it nor do nothing: they
 * ask. That is the relaxation F-502-p paid for — a key can be reissued from
 * this screen, so the answer to "close?" is now a real answer rather than a
 * door that has to stay shut. The X and "done" are aimed at, and still close
 * it on the first press.
 */
describe("the key on screen", () => {
  const grant = {
    kind: "free_grant" as const,
    code: "FREEVPN",
    grant: {
      id: "g1",
      variantId: "v1",
      startsAt: "2026-09-15T00:00:00.000Z",
      endsAt: "2026-10-15T00:00:00.000Z",
      featureKeys: ["vpn.access"],
    },
    subscriptionKey: "KEY-3kq9-once",
  };

  async function granted() {
    const user = userEvent.setup();
    redeemGift.mockResolvedValue(grant);
    const opened = open();

    fillCode("FREEVPN");
    await user.click(submit());
    await screen.findByText("wallet.gift.serviceTitle");

    return { user, ...opened };
  }

  it("is not dismissed by Escape — it asks first", async () => {
    const { user, onClose } = await granted();

    await user.keyboard("{Escape}");

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("wallet.gift.closeAsk")).toBeInTheDocument();
    expect(screen.getByText("KEY-3kq9-once")).toBeInTheDocument();
  });

  it("is not dismissed by a click on the backdrop — it asks first", async () => {
    const { user, onClose } = await granted();

    await user.click(screen.getByTestId("gift-backdrop"));

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("wallet.gift.closeAsk")).toBeInTheDocument();
    expect(screen.getByText("KEY-3kq9-once")).toBeInTheDocument();
  });

  it("closes when the asked question is answered, and goes back when it is not", async () => {
    const { user, onClose } = await granted();

    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "wallet.gift.stay" }));

    // Back to the key, with nothing closed and nothing lost.
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText("wallet.gift.closeAsk")).not.toBeInTheDocument();
    expect(screen.getByText("KEY-3kq9-once")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "wallet.gift.closeAnyway" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on the two controls the user aims at", async () => {
    const { user, onClose } = await granted();

    await user.click(screen.getByRole("button", { name: "wallet.gift.done" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "wallet.gift.close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("leaves the empty box dismissible — nothing has been shown to lose yet", async () => {
    const user = userEvent.setup();
    const { onClose } = open();

    await user.click(screen.getByTestId("gift-backdrop"));

    expect(onClose).toHaveBeenCalled();
  });
});

/**
 * A key that did not reach the user (F-502-q), over F-502-p's
 * `POST /gift/grants/:id/rotate-token`.
 *
 * The key is shown once and only hashed (D-35), and until F-502-p that made a
 * failed copy final: the clipboard write can throw on an insecure origin, the
 * selection can be half a key, the paste can land in the wrong window. The
 * button asks billing to mint a new one, and what comes back obeys the same
 * rule as the first — shown this once, hashed on billing's side, with the old
 * key already dead in the same transaction.
 *
 * It is the Grant's id that is sent and nothing else: the route takes no body
 * and the owner is the gate's user (`billing/contract.gift.md`).
 */
describe("a key that did not reach the user", () => {
  const grant = {
    kind: "free_grant" as const,
    code: "FREEVPN",
    grant: {
      id: "g1",
      variantId: "v1",
      startsAt: "2026-09-15T00:00:00.000Z",
      endsAt: "2026-10-15T00:00:00.000Z",
      featureKeys: ["vpn.access"],
    },
    subscriptionKey: "KEY-3kq9-once",
  };

  async function granted() {
    const user = userEvent.setup();
    redeemGift.mockResolvedValue(grant);
    const opened = open();

    fillCode("FREEVPN");
    await user.click(submit());
    await screen.findByText("wallet.gift.serviceTitle");

    return { user, ...opened };
  }

  const askForOne = () => screen.getByRole("button", { name: "wallet.gift.newKey" });

  it("asks for one by Grant id, and shows it in place of the key it replaced", async () => {
    rotateGrantToken.mockResolvedValue({ grantId: "g1", subscriptionKey: "KEY-7mx2-again" });
    const { user } = await granted();

    await user.click(askForOne());

    await waitFor(() => expect(rotateGrantToken).toHaveBeenCalledWith("g1"));
    expect(await screen.findByText("KEY-7mx2-again")).toBeInTheDocument();
    // The old one stopped working inside billing's transaction, so it must not
    // still be on screen to be copied.
    expect(screen.queryByText("KEY-3kq9-once")).not.toBeInTheDocument();
    expect(screen.getByText("wallet.gift.keyReplaced")).toBeInTheDocument();
    // Same rule as the first key: this is the only time it exists in the clear.
    expect(screen.getByText("wallet.gift.keyOnce")).toBeInTheDocument();
  });

  it("leaves the key on screen alone when billing refuses", async () => {
    rotateGrantToken.mockRejectedValue(
      new ApiError("Too many attempts. Try again later.", { status: 429, ref: "f00dcafe11" }),
    );
    const { user } = await granted();

    await user.click(askForOne());

    expect(await screen.findByRole("alert")).toHaveTextContent("Too many attempts. Try again later.");
    // A refused ask mints nothing, so the key the user has is still the key.
    expect(screen.getByText("KEY-3kq9-once")).toBeInTheDocument();
    expect(screen.queryByText("wallet.gift.keyReplaced")).not.toBeInTheDocument();
  });

  it("is not asked twice while the first ask is in flight — the bucket is 5 per 15 minutes", async () => {
    let answer: (v: never) => void = () => undefined;
    rotateGrantToken.mockReturnValue(new Promise((resolve) => (answer = resolve as never)));
    const { user } = await granted();

    await user.click(askForOne());

    expect(screen.getByRole("button", { name: "wallet.gift.newKeySending" })).toBeDisabled();
    answer({ grantId: "g1", subscriptionKey: "KEY-7mx2-again" } as never);
    await screen.findByText("KEY-7mx2-again");
    expect(rotateGrantToken).toHaveBeenCalledTimes(1);
  });
});
