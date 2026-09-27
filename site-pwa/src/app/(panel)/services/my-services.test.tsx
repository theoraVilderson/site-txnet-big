import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocale } from "@/context/LocaleContext";
import { billingApi, type GrantRow } from "@/lib/billing-api";
import { ApiError } from "@/lib/api-error";
import { copyText } from "../_lib/clipboard";
import { ServiceRow } from "./_components/ServiceRow";
import { GRANT_STATUSES, GRANT_TONES, capabilityNames } from "./_lib/my-services";
import {
  CONFIG_ACTION_REFUSALS,
  CONFIG_STATUSES,
  DRIFT_STATES,
  DRIFT_VERDICTS,
  REFUSAL_KEYS,
  configName,
  formatBytes,
  purgeCountdown,
} from "./_lib/service-configs";
import { timeLeft } from "./_lib/usage";
import type { UserConfigRow } from "@/lib/billing-api";

/**
 * The "my services" page (F-502-s), and the two things about it that break
 * silently:
 *
 * > **A key that did not reach the user is asked for again from a row** — the
 * > whole reason this page exists. Billing keeps only the hash of a
 * > subscription key (D-35), so before this page the reissue button
 * > (F-502-q) was reachable only while the redemption modal was still up. A
 * > row that minted a key and left the old one on screen would hand the user
 * > a credential billing killed in the same transaction, and one that mints
 * > on a refusal would do the opposite.
 *
 * > **Every status is named.** The ended ones come only on "show ended
 * > services" (`domains/billing/contract.gift.md`), but a key is lost from
 * > them as easily as from a live one. A status this
 * > page has no sentence for is a blank pill, and a status it refuses the
 * > button on is the row the user came for.
 *
 * The status union is read out of the Prisma enum rather than restated, so a
 * seventh status goes red here instead of rendering as nothing.
 */

const REPO = join(__dirname, "../../../../..");
const ENTITLEMENT_PRISMA = join(REPO, "txnet-backend/prisma/domains/entitlement.prisma");

const NETWORK_PRISMA = join(REPO, "txnet-backend/prisma/domains/network.prisma");
const CONFIG_ACTIONS_TS = join(REPO, "txnet-backend/billing-service/src/app/traffic/config-actions.ts");

function enumOf(file: string, name: string): string[] {
  const block = new RegExp(`enum ${name} \\{([\\s\\S]*?)\\}`).exec(readFileSync(file, "utf8"));
  if (!block) throw new Error(`${name} is no longer an enum in ${file} — this test is stale`);
  return block[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[a-z_0-9]+$/.test(line));
}

const statusesBillingCanAnswer = () => enumOf(ENTITLEMENT_PRISMA, "GrantStatus");

/** Billing's `CONFIG_ACTION_REJECTIONS` tuple, read as it ships. */
function rejectionsBillingCanAnswer(): string[] {
  const block = /CONFIG_ACTION_REJECTIONS = \[([\s\S]*?)\] as const/.exec(readFileSync(CONFIG_ACTIONS_TS, "utf8"));
  if (!block) throw new Error("CONFIG_ACTION_REJECTIONS moved — this test is stale");
  return [...block[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
vi.mock("../_lib/clipboard", () => ({ copyText: vi.fn(async () => true) }));
/**
 * The client is faked, but its *constants* are the shipped ones: `GRANT_STATUSES`
 * is the union this page's tones are checked against, and a mock that restated
 * it would be checking a copy of the list against the schema instead of the
 * list the page actually renders from.
 */
vi.mock("@/lib/billing-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing-api")>()),
  billingApi: {
    subscriptionLink: vi.fn(),
    resetSubscriptionLink: vi.fn(),
    grantConfigs: vi.fn(),
    grantUsage: vi.fn(() => new Promise(() => {})),
    configAction: vi.fn(),
  },
}));

const subscriptionLink = vi.mocked(billingApi.subscriptionLink);
const resetSubscriptionLink = vi.mocked(billingApi.resetSubscriptionLink);
const grantConfigs = vi.mocked(billingApi.grantConfigs);
const configAction = vi.mocked(billingApi.configAction);

/** The key back, so an assertion names the string the component asked for. */
const t = (_ns: string, key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}:${Object.values(vars).join(",")}` : key;

const GRANT: GrantRow = {
  id: "g1",
  status: "active",
  startsAt: "2026-09-01T00:00:00.000Z",
  endsAt: "2026-12-01T00:00:00.000Z",
  featureKeys: ["vpn.pro"],
  variant: { id: "v1", sku: "VPN_PRO-30D", nameKey: "catalog.product.vpn.name" },
  billingMode: "metered",
  consumedBytes: "1610612736",
  purchasedBytes: "2147483648",
  trafficUnlimited: false,
  trafficCapBytes: null,
  suspendedAt: null,
  purgeAt: null,
};

const CONFIG: UserConfigRow = {
  id: "c1",
  protocol: "vless",
  status: "active",
  region: "de-fra",
  allocatedCeilingBytes: "1073741824",
  appliedCeilingBytes: "1073741824",
  driftState: "synced",
  enforcementState: "complete",
  regenerateUsedCount: 0,
  maxRegenerateCount: 3,
  lastReconciledAt: null,
  label: null,
  lines: [],
  linksCapturedAt: null,
};

/** A row as the page shows it: the subscription link row is always there. */
const show = (row: Partial<GrantRow> = {}) =>
  render(<ServiceRow row={{ ...GRANT, ...row }} name="VPN Pro" capabilities={[]} />);
/** Open the row's "manage" fold — the 30 days, the configs' actions, reset. */
const details = () => fireEvent.click(screen.getByRole("button", { name: "myServices.manage.open" }));

const L = "myServices.link";
const LINK_1 = "https://sub.example.com/sub/tok-first";
const LINK_2 = "https://sub.example.com/sub/tok-second";
const button = (name: string) => screen.getByRole("button", { name });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useLocale).mockReturnValue({ lang: "en", t } as ReturnType<typeof useLocale>);
  subscriptionLink.mockResolvedValue({ grantId: "g1", subscriptionUrl: LINK_1 });
  grantConfigs.mockResolvedValue({ grantId: "g1", rows: [] });
  resetSubscriptionLink.mockResolvedValue({ grantId: "g1", subscriptionUrl: LINK_2 });
});

describe("the statuses billing can answer", () => {
  it("each have a sentence and a tone on this page", () => {
    expect([...GRANT_STATUSES].sort()).toEqual(statusesBillingCanAnswer().sort());
    expect(Object.keys(GRANT_TONES).sort()).toEqual([...GRANT_STATUSES].sort());
  });
});

describe("a paid Grant not yet delivered (F-111-f)", () => {
  it("says it is being prepared, and only while it is pending", () => {
    const { unmount } = show({ status: "pending" });
    expect(screen.getByText("myServices.preparing")).toBeTruthy();
    unmount();
    show({ status: "active" });
    expect(screen.queryByText("myServices.preparing")).toBeNull();
  });
});

describe("a Grant's capabilities (F-114-f-c)", () => {
  const TENANT = "t_0123456789abcdef0123456789abcdef";
  const texts = {
    "catalog.capability.vpn.pro.name": "Pro VPN",
    [`catalog.${TENANT}.capability.vpn.gaming.name`]: "Gaming routes",
    // Another tenant's capability under the same key: never this Grant's.
    "catalog.t_ffffffffffffffffffffffffffffffff.capability.vpn.gaming.name": "Someone else's",
  };
  const ownRow = { featureKeys: ["vpn.pro", "vpn.gaming", "vpn.unnamed"], variant: { ...GRANT.variant!, nameKey: `catalog.${TENANT}.product.vpn.name` } };

  it("names the platform's by its text and a tenant's own by its product's tenant", () => {
    expect(capabilityNames(texts, ownRow)).toEqual([
      { key: "vpn.pro", name: "Pro VPN" },
      { key: "vpn.gaming", name: "Gaming routes" },
      { key: "vpn.unnamed", name: null },
    ]);
  });

  it("reads only the platform's when the product is the platform's or there is none", () => {
    expect(capabilityNames(texts, { ...ownRow, variant: GRANT.variant })).toEqual([
      { key: "vpn.pro", name: "Pro VPN" },
      { key: "vpn.gaming", name: null },
      { key: "vpn.unnamed", name: null },
    ]);
    expect(capabilityNames(texts, { featureKeys: ["vpn.pro"], variant: null })).toEqual([{ key: "vpn.pro", name: "Pro VPN" }]);
  });

  it("shows the name, and the key only where no name was published", () => {
    render(
      <ServiceRow row={GRANT} name="VPN Pro" capabilities={[{ key: "vpn.pro", name: "Pro VPN" }, { key: "vpn.raw", name: null }]} />,
    );
    const list = screen.getByRole("list", { name: "myServices.features" });
    expect(list).toHaveTextContent("Pro VPN");
    expect(list).not.toHaveTextContent("vpn.pro");
    expect(list).toHaveTextContent("vpn.raw");
  });
});

describe("the verdicts, config statuses and refusals billing can answer", () => {
  it("each have a sentence on this page, and every verdict but synced says why", () => {
    expect([...DRIFT_STATES].sort()).toEqual(enumOf(NETWORK_PRISMA, "DriftState").sort());
    expect(Object.keys(DRIFT_VERDICTS).sort()).toEqual([...DRIFT_STATES].sort());
    for (const state of DRIFT_STATES) {
      expect(DRIFT_VERDICTS[state].whyKey === null).toBe(state === "synced");
    }
    // The list never answers a retired config: the user deleted it.
    expect([...CONFIG_STATUSES, "retired"].sort()).toEqual(enumOf(NETWORK_PRISMA, "ConfigStatus").sort());
    expect([...CONFIG_ACTION_REFUSALS].sort()).toEqual([...rejectionsBillingCanAnswer(), "failed"].sort());
    expect(Object.keys(REFUSAL_KEYS).sort()).toEqual([...CONFIG_ACTION_REFUSALS].sort());
  });
});

describe("usage and the purge clock", () => {
  it("shows consumed against purchased for a metered Grant", () => {
    show();
    expect(screen.getByText("myServices.usage:1.5 GB,2 GB")).toBeInTheDocument();
  });

  it("says unlimited traffic and unlimited time, never 0 bought or a blank end (F-111-s)", () => {
    // What billing answers for a Grant sold with traffic 0 and 0 days
    // (entitlement invariant 15): no bag, no end, and the flag saying why.
    const unlimited = show({ billingMode: "prepaid", purchasedBytes: "0", trafficUnlimited: true, endsAt: null, consumedBytes: "7516192768" });
    expect(screen.getByText("myServices.usageUnlimited:7 GB")).toBeInTheDocument();
    expect(screen.getByText(/^myServices\.periodUnlimited:/)).toBeInTheDocument();
    expect(screen.queryByText(/0 B/)).toBeNull();
    unlimited.unmount();
    // A prepaid Grant billing answers no cap for says only what it used.
    show({ billingMode: "prepaid", trafficUnlimited: false });
    expect(screen.getByText("myServices.usageUnmetered:1.5 GB")).toBeInTheDocument();
  });

  it("shows a capped prepaid Grant used against its cap, with a ring — the cap /sub gives the app (F-111-t)", () => {
    // Billing's cap is the limit plus a rollover, not `purchasedBytes`.
    show({ billingMode: "prepaid", purchasedBytes: "2147483648", trafficCapBytes: "3221225472" });
    expect(screen.getByText("myServices.usage:1.5 GB,3 GB")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /^myServices\.ring\.label:/ })).toBeInTheDocument();
  });

  it("counts down to the purge in days and hours, and says when it is due", () => {
    const now = new Date("2026-09-23T00:00:00Z");
    expect(purgeCountdown("2026-09-25T05:30:00Z", now)).toEqual({ days: 2, hours: 5 });
    expect(purgeCountdown("2026-09-22T00:00:00Z", now)).toBe("due");
    expect(purgeCountdown(null, now)).toBeNull();
    expect(formatBytes("0", "en")).toBe("0 B");
    // Past 2^53: a decimal string, never a float that rounded on the wire.
    expect(formatBytes("18014398509481984", "en")).toBe("16 PB");
  });

  it("counts the time left in days, hours and minutes, a part minute as one, and none once the end has passed (F-307-s)", () => {
    const now = new Date("2026-09-10T12:00:00Z");
    expect(timeLeft("2026-09-01T00:00:00Z", "2026-09-13T17:30:00Z", now)).toMatchObject({ days: 3, hours: 5, minutes: 30 });
    // The last day is hours and minutes, never "1 day" until the end.
    expect(timeLeft("2026-09-01T00:00:00Z", "2026-09-11T00:00:00Z", now)).toEqual({ days: 0, hours: 12, minutes: 0, spent: 0.95 });
    expect(timeLeft("2026-09-01T00:00:00Z", "2026-09-10T12:00:01Z", now)).toMatchObject({ days: 0, hours: 0, minutes: 1 });
    expect(timeLeft("2026-09-01T00:00:00Z", "2026-09-10T00:00:00Z", now)).toEqual({ days: 0, hours: 0, minutes: 0, spent: 1 });
    expect(timeLeft("2026-09-01T00:00:00Z", null, now)).toBeNull();
  });

  it("says days and hours, under a day hours and minutes, and counts down in the browser with no read (F-307-s)", () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      vi.setSystemTime(new Date("2026-09-27T10:00:30Z"));
      const far = show({ endsAt: "2026-09-30T15:00:30Z" });
      expect(screen.getByText("myServices.left.dayHours:3,5")).toBeInTheDocument();
      far.unmount();
      show({ endsAt: "2026-09-28T00:20:30Z" });
      expect(screen.getByText("myServices.left.hourMinutes:14,20")).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(60_000));
      expect(screen.getByText("myServices.left.hourMinutes:14,19")).toBeInTheDocument();
      // A tab asleep for hours: the next tick counts from the clock, not from ticks.
      act(() => {
        vi.setSystemTime(new Date("2026-09-28T00:00:30Z"));
        vi.advanceTimersByTime(60_000);
      });
      expect(screen.getByText("myServices.left.minutes:19")).toBeInTheDocument();
      act(() => {
        vi.setSystemTime(new Date("2026-09-28T00:20:00Z"));
        vi.advanceTimersByTime(60_000);
      });
      expect(screen.getByText("myServices.left.ended")).toBeInTheDocument();
      expect(billingApi.grantUsage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the countdown only when billing answered a purge instant", () => {
    const { unmount } = show();
    expect(screen.queryByText(/myServices\.purge/)).not.toBeInTheDocument();
    unmount();
    show({ status: "suspended", suspendedAt: "2026-09-20T00:00:00Z", purgeAt: "2020-01-01T00:00:00Z" });
    expect(screen.getByText("myServices.purgeDue")).toBeInTheDocument();
  });
});

describe("a Grant's servers, under details", () => {
  const open = async (rows: UserConfigRow[]) => {
    grantConfigs.mockResolvedValue({ grantId: "g1", rows });
    const user = userEvent.setup();
    render(<ServiceRow row={GRANT} name="VPN Pro" capabilities={[]} />);
    await user.click(screen.getByRole("button", { name: "myServices.manage.open" }));
    await screen.findAllByText(/de-fra/);
    return user;
  };

  it("reads nothing until opened", () => {
    render(<ServiceRow row={GRANT} name="VPN Pro" capabilities={[]} />);
    expect(grantConfigs).not.toHaveBeenCalled();
  });

  it("makes every non-synced verdict a button that says why, and says nothing for a healthy one", async () => {
    const user = await open([CONFIG, { ...CONFIG, id: "c2", region: "de-fra-2", driftState: "limit_overridden" }]);

    expect(screen.queryByText("myServices.configs.verdict.synced.label")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "myServices.configs.verdict.limit_overridden.label" }));
    expect(screen.getByText("myServices.configs.verdict.limit_overridden.why")).toBeInTheDocument();
  });

  it("says when the panel has not yet taken the whole ceiling", async () => {
    await open([{ ...CONFIG, appliedCeilingBytes: "536870912" }]);
    expect(screen.getByText("myServices.configs.ceilingQueued:1 GB,512 MB")).toBeInTheDocument();
  });

  it("acts on the ticked configs in one request, names the refused one, and reads the list again", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    configAction.mockResolvedValue({
      action: "retire",
      results: [
        { configId: "c1", ok: true },
        { configId: "c2", ok: false, reason: "config_changed" },
      ],
    });
    const user = await open([CONFIG, { ...CONFIG, id: "c2", protocol: "trojan" }]);

    await user.click(screen.getByRole("checkbox", { name: "myServices.configs.selectAll" }));
    await user.click(screen.getByRole("button", { name: "myServices.configs.bulkRetire" }));

    await waitFor(() => expect(configAction).toHaveBeenCalledWith("retire", ["c1", "c2"]));
    expect(await screen.findByText("myServices.configs.done:1")).toBeInTheDocument();
    const refused = screen.getByRole("alert");
    expect(refused).toHaveTextContent("trojan · de-fra");
    expect(refused).toHaveTextContent("myServices.configs.refusal.config_changed");
    await waitFor(() => expect(grantConfigs).toHaveBeenCalledTimes(2));
  });

  it("deletes nothing when the confirmation is declined", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = await open([CONFIG]);
    await user.click(screen.getByRole("button", { name: "myServices.configs.retire" }));
    expect(configAction).not.toHaveBeenCalled();
  });

  it("names a server by its panel's label, else its protocol and region", () => {
    expect(configName({ ...CONFIG, lines: ["vless://u@h:443?x=1#DE%20Reality"] })).toBe("DE Reality");
    expect(configName({ ...CONFIG, lines: ["vless://u@h:443"] })).toBe("vless · de-fra");
    expect(configName(CONFIG)).toBe("vless · de-fra");
  });

  it("offers no new key once a config's allowance is spent", async () => {
    await open([{ ...CONFIG, regenerateUsedCount: 3 }]);
    expect(screen.getByRole("button", { name: "myServices.configs.regenerate" })).toBeDisabled();
  });
});

describe("a row's subscription link (F-114-e-c)", () => {
  it("offers copy and QR on the row, reset only under manage, whatever the status, and never says key", () => {
    const { container } = show({ status: "expired", endsAt: "2026-01-01T00:00:00.000Z" });
    expect(button(`${L}.copy`)).toBeEnabled();
    expect(button(`${L}.showQr`)).toBeEnabled();
    // The row changes nothing: what can break a working setup is one press further.
    expect(screen.queryByRole("button", { name: `${L}.reset` })).not.toBeInTheDocument();
    details();
    expect(button(`${L}.reset`)).toBeEnabled();
    expect(container.textContent ?? "").not.toMatch(/wallet\.gift\.key|newKey/);
  });

  it("reads nothing until asked: the list never carries the link", () => {
    show();
    expect(subscriptionLink).not.toHaveBeenCalled();
    expect(screen.queryByText(LINK_1)).not.toBeInTheDocument();
  });

  it("copies the link billing answers for this Grant, and asks once per row", async () => {
    const user = userEvent.setup();
    show();

    await user.click(button(`${L}.copy`));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(LINK_1));
    expect(subscriptionLink).toHaveBeenCalledWith("g1");
    expect(await screen.findByRole("button", { name: `${L}.copied` })).toBeInTheDocument();

    await user.click(button(`${L}.showQr`));
    expect(await screen.findByRole("img", { name: `${L}.qrLabel` })).toBeInTheDocument();
    expect(screen.getByText(LINK_1)).toBeInTheDocument();
    expect(subscriptionLink).toHaveBeenCalledTimes(1);
  });

  it("shows the link to select by hand when the clipboard refuses", async () => {
    vi.mocked(copyText).mockResolvedValueOnce(false);
    const user = userEvent.setup();
    show();

    await user.click(button(`${L}.copy`));
    expect(await screen.findByText(LINK_1)).toBeInTheDocument();
  });

  it("shows billing's sentence on a refusal — an older Grant's link_not_kept — and still offers reset", async () => {
    subscriptionLink.mockRejectedValue(new ApiError("press reset link once", { status: 409, ref: "req-9" }));
    const user = userEvent.setup();
    show();

    await user.click(button(`${L}.copy`));
    expect(await screen.findByRole("alert")).toHaveTextContent("press reset link once");
    expect(screen.getByText("req-9")).toBeInTheDocument();
    expect(copyText).not.toHaveBeenCalled();
    details();
    expect(button(`${L}.reset`)).toBeEnabled();
  });
});

describe("resetting a link", () => {
  it("asks first, and a declined confirmation resets nothing", async () => {
    const user = userEvent.setup();
    show();
    details();

    await user.click(button(`${L}.reset`));
    expect(screen.getByText(`${L}.resetConfirm`)).toBeInTheDocument();
    await user.click(button(`${L}.resetNo`));

    expect(resetSubscriptionLink).not.toHaveBeenCalled();
    expect(screen.queryByText(`${L}.resetConfirm`)).not.toBeInTheDocument();
  });

  it("replaces the link on screen with the new one, because the old one stopped working", async () => {
    const user = userEvent.setup();
    show();

    await user.click(button(`${L}.showQr`));
    expect(await screen.findByText(LINK_1)).toBeInTheDocument();

    details();
    await user.click(button(`${L}.reset`));
    await user.click(button(`${L}.resetYes`));

    await waitFor(() => expect(resetSubscriptionLink).toHaveBeenCalledWith("g1"));
    // The open QR dialog and the manage fold both show the new link, never the old.
    expect((await screen.findAllByText(LINK_2)).length).toBeGreaterThan(0);
    expect(screen.queryByText(LINK_1)).not.toBeInTheDocument();
    expect(screen.getByText(`${L}.resetDone`)).toBeInTheDocument();
  });

  it("changes nothing on a refusal and shows billing's own sentence", async () => {
    const user = userEvent.setup();
    show();
    await user.click(button(`${L}.showQr`));
    expect(await screen.findByText(LINK_1)).toBeInTheDocument();

    resetSubscriptionLink.mockRejectedValue(new ApiError("too many requests, try again later", { status: 429, ref: "req-7" }));
    details();
    await user.click(button(`${L}.reset`));
    await user.click(button(`${L}.resetYes`));

    expect(await screen.findByRole("alert")).toHaveTextContent("too many requests, try again later");
    expect(screen.queryByText(`${L}.resetDone`)).not.toBeInTheDocument();
    // The QR still open above shows the first link: nothing was replaced.
    expect(screen.getByText(LINK_1)).toBeInTheDocument();
    expect(subscriptionLink).toHaveBeenCalledTimes(1);
  });

  it("never asks twice while a reset is in flight — each call destroys a working link", async () => {
    const user = userEvent.setup();
    let answer: (v: { grantId: string; subscriptionUrl: string }) => void = () => {};
    resetSubscriptionLink.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    show();
    details();

    await user.click(button(`${L}.reset`));
    await user.click(button(`${L}.resetYes`));
    expect(screen.getByRole("button", { name: `${L}.resetting` })).toBeDisabled();

    answer({ grantId: "g1", subscriptionUrl: LINK_2 });
    await waitFor(() => expect(resetSubscriptionLink).toHaveBeenCalledTimes(1));
  });
});
