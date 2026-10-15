import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render as rtlRender, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { RealtimeEvents } from "@/generated/wire";
import { ApiError } from "@/lib/api-error";
import { billingApi, type GrantRow } from "@/lib/billing-api";
import { ConfirmProvider } from "../_components/kit";
import { ServiceRow } from "./_components/ServiceRow";
import { readFreezeChanged } from "./_lib/my-services";
import { freezeLimitOf, ownFreezeOf } from "./_lib/own-freeze";

/**
 * The user's own freeze on My services (F-0401-e, billing `contract.gift.md`
 * "Freezing one's own service", panel-web `contract.services.md`).
 *
 * > **The card offers only what billing would take**: a freeze on a live
 * > pay-as-you-go service, an unfreeze where `userMayUnfreeze` says so — and a
 * > hard freeze is support's, named, with no button.
 *
 * > **Both ask first.** A freeze switches every config off.
 *
 * > **A refusal is named**: the daily cap with when the next one is allowed,
 * > the reseller's off switch with billing's sentence.
 */

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
vi.mock("@/lib/billing-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing-api")>()),
  billingApi: {
    freezeOwnGrant: vi.fn(),
    unfreezeOwnGrant: vi.fn(),
    spendingCap: vi.fn(() => new Promise(() => {})),
    subscriptionLink: vi.fn(),
    grantConfigs: vi.fn(),
    grantUsage: vi.fn(() => new Promise(() => {})),
    grantPeriod: vi.fn(() => new Promise(() => {})),
  },
}));

const S = FrontendI18nKeys.common.myServices;
const F = S.freeze;
const t = (_ns: string, key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}:${Object.values(vars).join(",")}` : key;
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: ConfirmProvider });

const freeze = vi.mocked(billingApi.freezeOwnGrant);
const unfreeze = vi.mocked(billingApi.unfreezeOwnGrant);

const METERED: GrantRow = {
  id: "g1",
  label: null,
  status: "active",
  startsAt: "2026-10-01T00:00:00.000Z",
  endsAt: null,
  featureKeys: [],
  variant: null,
  billingMode: "metered",
  consumedBytes: "0",
  purchasedBytes: "0",
  trafficUnlimited: false,
  trafficCapBytes: null,
  suspendedAt: null,
  purgeAt: null,
  lastTrafficAt: null,
  frozen: false,
  frozenUntil: null,
  freezeMode: null,
  userMayUnfreeze: false,
};
const frozenBy = (freezeMode: "hard" | "soft" | "self"): GrantRow => ({
  ...METERED,
  status: "suspended",
  suspendedAt: "2026-10-14T10:00:00.000Z",
  frozen: true,
  freezeMode,
  userMayUnfreeze: freezeMode !== "hard",
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useLocale).mockReturnValue({ lang: "en", t } as ReturnType<typeof useLocale>);
  vi.mocked(billingApi.grantConfigs).mockResolvedValue({ grantId: "g1", rows: [] });
});

/** Answers the kit's dialog: its last button confirms. */
function answer(yes: boolean) {
  const dialog = within(screen.getByRole("dialog"));
  fireEvent.click(yes ? dialog.getAllByRole("button").at(-1)! : dialog.getByRole("button", { name: "kit.confirm.cancel" }));
}

describe("what a card offers", () => {
  it("a freeze on a live pay-as-you-go service only", () => {
    expect(ownFreezeOf(METERED)).toBe("freeze");
    expect(ownFreezeOf({ ...METERED, billingMode: "prepaid" })).toBeNull();
    const unlimited: GrantRow = { ...METERED, trafficUnlimited: true };
    expect(ownFreezeOf(unlimited)).toBe("freeze");
    // Stopped by its quota, not frozen: a top-up's, never an unfreeze.
    expect(ownFreezeOf({ ...METERED, status: "suspended" })).toBeNull();
    expect(ownFreezeOf({ ...METERED, status: "expired" })).toBeNull();
  });

  it("an unfreeze where billing says the user may, and support's name where it does not", () => {
    expect(ownFreezeOf(frozenBy("self"))).toBe("unfreeze");
    expect(ownFreezeOf(frozenBy("soft"))).toBe("unfreeze");
    expect(ownFreezeOf(frozenBy("hard"))).toBe("support");
    // A soft freeze waiting for a panel: billing answers false, and that is the rule.
    expect(ownFreezeOf({ ...frozenBy("soft"), userMayUnfreeze: false })).toBe("support");
    // A frozen prepaid package an admin froze softly is the user's to lift too.
    expect(ownFreezeOf({ ...frozenBy("soft"), billingMode: "prepaid" })).toBe("unfreeze");
  });
});

describe("the daily cap", () => {
  it("is read from billing's reason and figures, else left to its sentence", () => {
    const at = Date.parse("2026-10-15T08:00:00.000Z");
    const limited = new ApiError("x", { status: 429, reason: "self_freeze_limit", facts: { limit: 3, nextAtMs: at } });
    expect(freezeLimitOf(limited)).toEqual({ limit: 3, nextAt: "2026-10-15T08:00:00.000Z" });
    expect(freezeLimitOf(new ApiError("x", { status: 429, reason: "self_freeze_limit", facts: { limit: 3 } }))).toBeNull();
    expect(freezeLimitOf(new ApiError("x", { status: 403, reason: "self_freeze_off" }))).toBeNull();
  });
});

describe("on the card", () => {
  it("names a hard freeze as support's, with no button", () => {
    render(<ServiceRow row={frozenBy("hard")} name="VPN" capabilities={[]} />);
    expect(screen.getByText(F.byHard)).toBeTruthy();
    expect(screen.queryByRole("button", { name: F.unfreeze })).toBeNull();
  });

  it("names a soft and a self freeze, and unfreezes after the question", async () => {
    unfreeze.mockResolvedValue({ grantId: "g1", endsAt: null, configsRestored: 2 });
    const { unmount } = render(<ServiceRow row={frozenBy("soft")} name="VPN" capabilities={[]} />);
    expect(screen.getByText(F.bySoft)).toBeTruthy();
    unmount();

    render(<ServiceRow row={frozenBy("self")} name="VPN" capabilities={[]} />);
    expect(screen.getByText(F.bySelf)).toBeTruthy();
    const note = () => within(screen.getByRole("region", { name: F.title }));
    fireEvent.click(note().getByRole("button", { name: F.unfreeze }));
    answer(false);
    expect(unfreeze).not.toHaveBeenCalled();
    fireEvent.click(note().getByRole("button", { name: F.unfreeze }));
    answer(true);
    await waitFor(() => expect(unfreeze).toHaveBeenCalledWith("g1"));
  });

  it("freezes a live metered service from manage, after the question", async () => {
    freeze.mockResolvedValue({ grantId: "g1", freezeMode: "self", configsDisabled: 2 });
    render(<ServiceRow row={METERED} name="VPN" capabilities={[]} />);
    fireEvent.click(screen.getByRole("button", { name: S.manage.open }));
    fireEvent.click(screen.getByRole("button", { name: F.freeze }));
    expect(screen.getByRole("dialog").textContent).toContain(F.confirmFreeze.body);
    answer(true);
    await waitFor(() => expect(freeze).toHaveBeenCalledWith("g1"));
  });

  it("offers nothing on a prepaid package", () => {
    render(<ServiceRow row={{ ...METERED, billingMode: "prepaid" }} name="VPN" capabilities={[]} />);
    fireEvent.click(screen.getByRole("button", { name: S.manage.open }));
    expect(screen.queryByRole("button", { name: F.freeze })).toBeNull();
  });

  it("names the daily cap with when the next freeze is allowed", async () => {
    freeze.mockRejectedValue(new ApiError("billing's", { status: 429, reason: "self_freeze_limit", facts: { limit: 3, nextAtMs: Date.now() + 3_600_000 } }));
    render(<ServiceRow row={METERED} name="VPN" capabilities={[]} />);
    fireEvent.click(screen.getByRole("button", { name: S.manage.open }));
    fireEvent.click(screen.getByRole("button", { name: F.freeze }));
    answer(true);
    expect((await screen.findByRole("alert")).textContent).toContain(`${F.limited}:3,`);
    expect((screen.getByRole("button", { name: F.freeze }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("names the reseller's off switch in billing's own sentence", async () => {
    freeze.mockRejectedValue(new ApiError("Freezing a service yourself is not available in this store.", { status: 403, reason: "self_freeze_off" }));
    render(<ServiceRow row={METERED} name="VPN" capabilities={[]} />);
    fireEvent.click(screen.getByRole("button", { name: S.manage.open }));
    fireEvent.click(screen.getByRole("button", { name: F.freeze }));
    answer(true);
    expect((await screen.findByRole("alert")).textContent).toContain("not available in this store");
  });
});

describe("the live event", () => {
  it("names the Grant whose freeze moved, and nothing else", () => {
    expect(readFreezeChanged({ type: RealtimeEvents.grantFreezeChanged, grantId: "g1" })).toEqual({ grantId: "g1" });
    expect(readFreezeChanged({ type: RealtimeEvents.grantUsage, grantId: "g1" })).toBeNull();
    expect(readFreezeChanged({ type: RealtimeEvents.grantFreezeChanged })).toBeNull();
  });
});
