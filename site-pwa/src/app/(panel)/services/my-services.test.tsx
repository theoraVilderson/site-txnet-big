import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocale } from "@/context/LocaleContext";
import { billingApi, type GrantRow } from "@/lib/billing-api";
import { ApiError } from "@/lib/api-error";
import { ServiceRow } from "./_components/ServiceRow";
import { GrantConfigs } from "./_components/GrantConfigs";
import { GRANT_STATUSES, GRANT_TONES } from "./_lib/my-services";
import {
  CONFIG_ACTION_REFUSALS,
  CONFIG_STATUSES,
  DRIFT_STATES,
  DRIFT_VERDICTS,
  REFUSAL_KEYS,
  formatBytes,
  purgeCountdown,
} from "./_lib/service-configs";
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
 * > **Every status is listed and every status is named.** Billing answers the
 * > status and never filters (`domains/billing/contract.gift.md`), because a
 * > key is lost from an expired Grant as easily as a live one. A status this
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
/**
 * The client is faked, but its *constants* are the shipped ones: `GRANT_STATUSES`
 * is the union this page's tones are checked against, and a mock that restated
 * it would be checking a copy of the list against the schema instead of the
 * list the page actually renders from.
 */
vi.mock("@/lib/billing-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing-api")>()),
  billingApi: { rotateGrantToken: vi.fn(), grantConfigs: vi.fn(), configAction: vi.fn() },
}));

const rotateGrantToken = vi.mocked(billingApi.rotateGrantToken);
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
};

const show = (row: Partial<GrantRow> = {}) =>
  render(<ServiceRow row={{ ...GRANT, ...row }} name="VPN Pro" />);

const newKeyButton = () => screen.getByRole("button", { name: "wallet.gift.newKey" });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useLocale).mockReturnValue({ lang: "en", t } as ReturnType<typeof useLocale>);
  rotateGrantToken.mockResolvedValue({ grantId: "g1", subscriptionKey: "KEY-first" });
});

describe("the statuses billing can answer", () => {
  it("each have a sentence and a tone on this page", () => {
    expect([...GRANT_STATUSES].sort()).toEqual(statusesBillingCanAnswer().sort());
    expect(Object.keys(GRANT_TONES).sort()).toEqual([...GRANT_STATUSES].sort());
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

  it("counts down to the purge in days and hours, and says when it is due", () => {
    const now = new Date("2026-09-23T00:00:00Z");
    expect(purgeCountdown("2026-09-25T05:30:00Z", now)).toEqual({ days: 2, hours: 5 });
    expect(purgeCountdown("2026-09-22T00:00:00Z", now)).toBe("due");
    expect(purgeCountdown(null, now)).toBeNull();
    expect(formatBytes("0", "en")).toBe("0 B");
    // Past 2^53: a decimal string, never a float that rounded on the wire.
    expect(formatBytes("18014398509481984", "en")).toBe("16 PB");
  });

  it("shows the countdown only when billing answered a purge instant", () => {
    const { unmount } = show();
    expect(screen.queryByText(/myServices\.purge/)).not.toBeInTheDocument();
    unmount();
    show({ status: "suspended", suspendedAt: "2026-09-20T00:00:00Z", purgeAt: "2020-01-01T00:00:00Z" });
    expect(screen.getByText("myServices.purgeDue")).toBeInTheDocument();
  });
});

describe("a Grant's configs", () => {
  const open = async (rows: UserConfigRow[]) => {
    grantConfigs.mockResolvedValue({ grantId: "g1", rows });
    const user = userEvent.setup();
    render(<GrantConfigs grantId="g1" />);
    await user.click(screen.getByRole("button", { name: "myServices.configs.show" }));
    await screen.findAllByText(/de-fra/);
    return user;
  };

  it("reads nothing until opened", () => {
    render(<GrantConfigs grantId="g1" />);
    expect(grantConfigs).not.toHaveBeenCalled();
  });

  it("makes every non-synced verdict a button that says why, and synced not one", async () => {
    const user = await open([CONFIG, { ...CONFIG, id: "c2", region: "de-fra-2", driftState: "limit_overridden" }]);

    expect(screen.queryByRole("button", { name: "myServices.configs.verdict.synced.label" })).not.toBeInTheDocument();
    expect(screen.getByText("myServices.configs.verdict.synced.label")).toBeInTheDocument();

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

  it("offers no new key once a config's allowance is spent", async () => {
    await open([{ ...CONFIG, regenerateUsedCount: 3 }]);
    expect(screen.getByRole("button", { name: "myServices.configs.regenerate" })).toBeDisabled();
  });
});

describe("a row", () => {
  it("offers the reissue button whatever the status — an expired Grant most of all", () => {
    show({ status: "expired", endsAt: "2026-01-01T00:00:00.000Z" });
    expect(newKeyButton()).toBeEnabled();
    expect(screen.getByText("myServices.status.expired")).toBeInTheDocument();
  });

  it("shows no key before one is asked for: billing never answers one in the list", () => {
    show();
    expect(screen.queryByText("wallet.gift.keyOnce")).not.toBeInTheDocument();
  });
});

describe("asking for a new key", () => {
  it("sends the Grant's id alone and shows what billing minted, once", async () => {
    const user = userEvent.setup();
    show();

    await user.click(newKeyButton());

    await waitFor(() => expect(rotateGrantToken).toHaveBeenCalledWith("g1"));
    expect(await screen.findByText("KEY-first")).toBeInTheDocument();
    expect(screen.getByText("wallet.gift.keyOnce")).toBeInTheDocument();
  });

  it("replaces the key on screen, because billing killed the old one in the same transaction", async () => {
    const user = userEvent.setup();
    show();

    await user.click(newKeyButton());
    expect(await screen.findByText("KEY-first")).toBeInTheDocument();

    rotateGrantToken.mockResolvedValue({ grantId: "g1", subscriptionKey: "KEY-second" });
    await user.click(newKeyButton());

    expect(await screen.findByText("KEY-second")).toBeInTheDocument();
    expect(screen.queryByText("KEY-first")).not.toBeInTheDocument();
    expect(screen.getByText("wallet.gift.keyReplaced")).toBeInTheDocument();
  });

  it("changes nothing on a refusal and shows billing's own sentence", async () => {
    const user = userEvent.setup();
    show();

    await user.click(newKeyButton());
    expect(await screen.findByText("KEY-first")).toBeInTheDocument();

    rotateGrantToken.mockRejectedValue(
      new ApiError("too many requests, try again later", { status: 429, ref: "req-7" }),
    );
    await user.click(newKeyButton());

    expect(await screen.findByRole("alert")).toHaveTextContent("too many requests, try again later");
    expect(screen.getByText("req-7")).toBeInTheDocument();
    // Nothing was minted, so the key already shown is still the key.
    expect(screen.getByText("KEY-first")).toBeInTheDocument();
  });

  it("never asks twice while an ask is in flight — each call destroys a working key", async () => {
    const user = userEvent.setup();
    let answer: (v: { grantId: string; subscriptionKey: string }) => void = () => {};
    rotateGrantToken.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    show();

    await user.click(newKeyButton());
    expect(screen.getByRole("button", { name: "wallet.gift.newKeySending" })).toBeDisabled();

    answer({ grantId: "g1", subscriptionKey: "KEY-first" });
    await waitFor(() => expect(rotateGrantToken).toHaveBeenCalledTimes(1));
  });
});
