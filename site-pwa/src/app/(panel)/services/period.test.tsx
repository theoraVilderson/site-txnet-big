import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { useLocale } from "@/context/LocaleContext";
import { billingApi, type GrantPeriodView, type GrantRow } from "@/lib/billing-api";
import { ServiceRow } from "./_components/ServiceRow";
import { UsageMeter } from "./_components/UsageMeter";
import { livePeriodBytes } from "./_lib/usage";

/**
 * A pay-as-you-go service's traffic (F-118-aj over billing's F-118-ai; user,
 * 2026-09-30): it has **no limit**, so the card never says "left of" what
 * billing happened to buy; and it counts **this billing period**, so a user
 * two months in does not read a total that only grows.
 *
 *  - the tile says "no cap, pay as you go" and leads with this period's bytes,
 *    then its cost, its dates, the last period and what the balance covers;
 *  - bytes pushed live after the read are added to the period, never lost;
 *  - no period read (the reseller's admin view, or a failed read) still says
 *    "no cap" with the lifetime total — never a bag as a bound.
 */

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
vi.mock("../_lib/clipboard", () => ({ copyText: vi.fn(async () => true) }));
vi.mock("@/lib/billing-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing-api")>()),
  billingApi: {
    grantConfigs: vi.fn(() => new Promise(() => {})),
    grantUsage: vi.fn(() => new Promise(() => {})),
    grantPeriod: vi.fn(),
    subscriptionLink: vi.fn(),
  },
}));

const t = (_ns: string, key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}:${Object.values(vars).join(",")}` : key;

const GIB = 1073741824;
const METERED: GrantRow = {
  id: "g1",
  label: null,
  status: "active",
  startsAt: "2026-07-08T14:00:00.000Z",
  endsAt: null,
  featureKeys: [],
  variant: { id: "v1", sku: "VPN_PAYG", nameKey: "catalog.product.vpn.name" },
  billingMode: "metered",
  consumedBytes: String(600 * GIB),
  purchasedBytes: String(601 * GIB),
  trafficUnlimited: false,
  trafficCapBytes: null,
  suspendedAt: null,
  purgeAt: null,
  lastTrafficAt: null,
};

const PERIOD: GrantPeriodView = {
  grantId: "g1",
  current: { from: "2026-09-08T14:00:00.000Z", to: "2026-10-08T14:00:00.000Z", consumedBytes: String(42 * GIB), spent: "105.00" },
  previous: { from: "2026-08-08T14:00:00.000Z", to: "2026-09-08T14:00:00.000Z", consumedBytes: String(480 * GIB), spent: "1200.00" },
  currencyCode: "USD",
  coversBytes: String(180 * GIB),
};

beforeEach(() => {
  vi.mocked(useLocale).mockReturnValue({ lang: "en", t } as ReturnType<typeof useLocale>);
  vi.mocked(billingApi.grantPeriod).mockReset();
});

describe("a pay-as-you-go service's traffic", () => {
  it("has no limit: no left-of, no percent, no bar toward the bag", () => {
    render(<UsageMeter row={METERED} live={false} warn />);
    expect(screen.getByText("myServices.meter.payg")).toBeInTheDocument();
    expect(screen.queryByText(/myServices\.meter\.of:/)).toBeNull();
    expect(screen.queryByText(/myServices\.meter\.percentLeft:/)).toBeNull();
    expect(screen.queryByRole("img", { name: /myServices\.ring\.label/ })).toBeNull();
    // With no period read, the lifetime total — the only figure there is.
    expect(screen.getByText("600 GB")).toBeInTheDocument();
    // Near the bag's end is not near anything: no running-out line.
    render(<UsageMeter row={{ ...METERED, consumedBytes: String(601 * GIB - 1) }} live={false} warn />);
    expect(screen.queryByText("myServices.meter.lowTraffic")).toBeNull();
  });

  it("leads with this period's bytes, then its cost, dates, the last period, what the balance covers and the lifetime total", () => {
    render(<UsageMeter row={METERED} live={false} warn period={{ view: PERIOD, baseline: METERED.consumedBytes }} />);
    expect(screen.getByText("42 GB")).toBeInTheDocument();
    expect(screen.getByText("myServices.meter.thisPeriod")).toBeInTheDocument();
    expect(screen.getByText(/^myServices\.meter\.periodCost:\$?105/)).toBeInTheDocument();
    expect(screen.getByText(/^myServices\.meter\.periodRange:/)).toBeInTheDocument();
    expect(screen.getByText(/^myServices\.meter\.previousPeriod:480 GB,/)).toBeInTheDocument();
    expect(screen.getByText("myServices.meter.covers:180 GB")).toBeInTheDocument();
    expect(screen.getByText("myServices.meter.lifetime:600 GB")).toBeInTheDocument();
  });

  it("says the balance covers nothing more, and leaves out what billing could not answer", () => {
    render(
      <UsageMeter
        row={METERED}
        live={false}
        warn
        period={{ view: { ...PERIOD, previous: null, coversBytes: "0", currencyCode: null }, baseline: METERED.consumedBytes }}
      />,
    );
    expect(screen.getByText("myServices.meter.coversNothing")).toBeInTheDocument();
    expect(screen.queryByText(/myServices\.meter\.previousPeriod/)).toBeNull();
    expect(screen.queryByText(/myServices\.meter\.periodCost/)).toBeNull();
  });

  it("adds bytes pushed after the read to the period, and never takes any away", () => {
    expect(livePeriodBytes("100", "1000", "1250")).toBe("350");
    expect(livePeriodBytes("100", "1000", "900")).toBe("100");
  });

  it("reads the period once for a metered row, and not for a package plan", async () => {
    vi.mocked(billingApi.grantPeriod).mockResolvedValue(PERIOD);
    const { rerender } = render(<ServiceRow row={METERED} name="VPN" capabilities={[]} />);
    await waitFor(() => expect(screen.getByText("42 GB")).toBeInTheDocument());
    expect(billingApi.grantPeriod).toHaveBeenCalledWith("g1");
    // A push raises the lifetime total by 2 GB: the period follows, with no second read.
    await act(async () => rerender(<ServiceRow row={{ ...METERED, consumedBytes: String(602 * GIB) }} name="VPN" capabilities={[]} />));
    expect(screen.getByText("44 GB")).toBeInTheDocument();
    expect(billingApi.grantPeriod).toHaveBeenCalledTimes(1);

    vi.mocked(billingApi.grantPeriod).mockClear();
    render(<ServiceRow row={{ ...METERED, id: "g2", billingMode: "prepaid", trafficCapBytes: String(2 * GIB) }} name="VPN" capabilities={[]} />);
    expect(billingApi.grantPeriod).not.toHaveBeenCalled();
  });

  it("keeps the no-cap tile with the lifetime total when the read fails", async () => {
    vi.mocked(billingApi.grantPeriod).mockRejectedValue(new Error("down"));
    render(<ServiceRow row={METERED} name="VPN" capabilities={[]} />);
    await waitFor(() => expect(billingApi.grantPeriod).toHaveBeenCalled());
    expect(screen.getByText("myServices.meter.payg")).toBeInTheDocument();
    expect(screen.getByText("600 GB")).toBeInTheDocument();
  });
});
