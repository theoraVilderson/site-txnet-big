import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { useLocale } from "@/context/LocaleContext";
import { billingApi, type GrantRow, type UserConfigRow } from "@/lib/billing-api";
import { ServiceRow } from "./_components/ServiceRow";
import { LIVE_WINDOW_MS, activityOf, agoOf, buildStage, levelOf } from "./_lib/pulse";

/**
 * A service that looks alive when it is, and a purchase that shows its
 * progress (F-307-u; user, 2026-09-27: "active configs don't feel alive —
 * make it obvious when one is moving data and when it is not; a service
 * being built should say so; the usage bar is confusing").
 *
 * > **"In use" is what the panels saw, never a guess.** A Grant is live while
 * > its last charged traffic is inside {@link LIVE_WINDOW_MS} — billing's
 * > `lastTrafficAt` on first paint, the time a usage push landed after it.
 * > Only a non-zero delta is charged, so an idle service never reads live.
 *
 * > **A purchase shows where it is.** Paid → built on the server (`pending`)
 * > → connection links (`active`, every config with no lines yet captured)
 * > → ready. The page moves along on the pushes it already hears.
 */

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
vi.mock("../_lib/clipboard", () => ({ copyText: vi.fn(async () => true) }));
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

const t = (_ns: string, key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}:${Object.values(vars).join(",")}` : key;

const NOW = new Date("2026-09-27T10:00:00Z");

const GRANT: GrantRow = {
  id: "g1",
  status: "active",
  startsAt: "2026-09-01T00:00:00.000Z",
  endsAt: "2026-12-01T00:00:00.000Z",
  featureKeys: [],
  variant: { id: "v1", sku: "VPN_PRO-30D", nameKey: "catalog.product.vpn.name" },
  billingMode: "metered",
  consumedBytes: "1610612736",
  purchasedBytes: "2147483648",
  trafficUnlimited: false,
  trafficCapBytes: null,
  suspendedAt: null,
  purgeAt: null,
  lastTrafficAt: null,
};

const CONFIG: UserConfigRow = {
  id: "c1",
  protocol: "vless",
  status: "active",
  region: "de-fra",
  allocatedCeilingBytes: null,
  appliedCeilingBytes: null,
  driftState: "synced",
  enforcementState: "complete",
  regenerateUsedCount: 0,
  maxRegenerateCount: 3,
  lastReconciledAt: null,
  label: null,
  lines: [],
  linksCapturedAt: null,
};

const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useLocale).mockReturnValue({ lang: "en", t } as ReturnType<typeof useLocale>);
  vi.mocked(billingApi.grantConfigs).mockResolvedValue({ grantId: "g1", rows: [] });
});

describe("the numbers behind the pulse", () => {
  it("is live inside the window, idle past it, and never-used with no traffic at all", () => {
    expect(activityOf(ago(20_000), NOW)).toEqual({ live: true, idleMs: 20_000 });
    expect(activityOf(ago(LIVE_WINDOW_MS + 1), NOW)).toEqual({ live: false, idleMs: LIVE_WINDOW_MS + 1 });
    expect(activityOf(null, NOW)).toEqual({ live: false, idleMs: null });
    // A clock a little ahead of the server's is not "in the future".
    expect(activityOf(ago(-5_000), NOW)).toEqual({ live: true, idleMs: 0 });
  });

  it("says how long ago in the largest whole unit", () => {
    expect(agoOf(30_000)).toEqual({ unit: "now", n: 0 });
    expect(agoOf(12 * 60_000)).toEqual({ unit: "minutes", n: 12 });
    expect(agoOf(5 * 3_600_000 + 1)).toEqual({ unit: "hours", n: 5 });
    expect(agoOf(3 * 86_400_000)).toEqual({ unit: "days", n: 3 });
  });

  it("colours what is left: plenty, running low under a quarter, nearly out under a tenth", () => {
    expect(levelOf(0.6)).toBe("ok");
    expect(levelOf(0.2)).toBe("low");
    expect(levelOf(0.05)).toBe("critical");
    expect(levelOf(0)).toBe("critical");
  });

  it("places a purchase on its steps", () => {
    expect(buildStage("pending", null)).toBe("server");
    expect(buildStage("active", [CONFIG])).toBe("links");
    // One config with lines is enough to connect.
    expect(buildStage("active", [CONFIG, { ...CONFIG, id: "c2", lines: ["vless://x"], linksCapturedAt: NOW.toISOString() }])).toBeNull();
    // A panel that gives no lines is not a wait (`linksCapturedAt` set).
    expect(buildStage("active", [{ ...CONFIG, linksCapturedAt: NOW.toISOString() }])).toBeNull();
    expect(buildStage("active", null)).toBeNull();
    expect(buildStage("active", [])).toBeNull();
    expect(buildStage("suspended", [CONFIG])).toBeNull();
  });
});

describe("a service row's pulse", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("reads live from billing's last traffic, and falls idle when the window passes with nothing new", () => {
    render(<ServiceRow row={{ ...GRANT, lastTrafficAt: ago(30_000) }} name="VPN" capabilities={[]} />);
    expect(screen.getByRole("status", { name: "myServices.pulse.live" })).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(LIVE_WINDOW_MS));
    expect(screen.queryByRole("status", { name: "myServices.pulse.live" })).toBeNull();
    expect(screen.getByRole("status", { name: "myServices.pulse.idle" })).toBeInTheDocument();
    // Idle two and a half minutes when the window closes, and the text turns on the minute.
    expect(screen.getByText("myServices.pulse.idleSince:myServices.ago.minutes:2")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText("myServices.pulse.idleSince:myServices.ago.minutes:3")).toBeInTheDocument();
  });

  it("says a service nobody has used yet is unused, not idle since some time", () => {
    render(<ServiceRow row={GRANT} name="VPN" capabilities={[]} />);
    expect(screen.getByText("myServices.pulse.never")).toBeInTheDocument();
  });

  it("turns live when a push raises the used bytes, and shows what the push added", () => {
    const { rerender } = render(<ServiceRow row={{ ...GRANT, lastTrafficAt: ago(3_600_000) }} name="VPN" capabilities={[]} />);
    expect(screen.getByRole("status", { name: "myServices.pulse.idle" })).toBeInTheDocument();

    // What `useGrantsPage` hands a row after a push: a larger total, stamped now.
    rerender(
      <ServiceRow row={{ ...GRANT, consumedBytes: "1715470336", lastTrafficAt: NOW.toISOString() }} name="VPN" capabilities={[]} />,
    );
    expect(screen.getByRole("status", { name: "myServices.pulse.live" })).toBeInTheDocument();
    expect(screen.getByText("+100 MB")).toBeInTheDocument();
  });

  it("claims nothing while metering is down, and nothing for a service that is not active", () => {
    const { unmount } = render(
      <ServiceRow row={{ ...GRANT, lastTrafficAt: ago(1_000) }} name="VPN" capabilities={[]} meteringDown />,
    );
    expect(screen.queryByText(/myServices\.pulse\./)).toBeNull();
    unmount();
    render(<ServiceRow row={{ ...GRANT, status: "expired", lastTrafficAt: ago(1_000) }} name="VPN" capabilities={[]} />);
    expect(screen.queryByText(/myServices\.pulse\./)).toBeNull();
  });
});

describe("the traffic meter", () => {
  it("leads with what is left, says of how much, and warns when nearly out", () => {
    const { unmount } = render(<ServiceRow row={GRANT} name="VPN" capabilities={[]} />);
    expect(screen.getByText("512 MB")).toBeInTheDocument();
    expect(screen.getByText("myServices.meter.of:2 GB")).toBeInTheDocument();
    expect(screen.getByText("myServices.meter.percentLeft:25")).toBeInTheDocument();
    expect(screen.queryByText("myServices.meter.lowTraffic")).toBeNull();
    unmount();
    render(<ServiceRow row={{ ...GRANT, consumedBytes: "2040109466" }} name="VPN" capabilities={[]} />);
    expect(screen.getByText("myServices.meter.lowTraffic")).toBeInTheDocument();
  });

  it("says unlimited for a Grant sold without a traffic bound", () => {
    render(<ServiceRow row={{ ...GRANT, billingMode: "prepaid", purchasedBytes: "0", trafficUnlimited: true }} name="VPN" capabilities={[]} />);
    expect(screen.getByText("myServices.meter.unlimited")).toBeInTheDocument();
  });
});

describe("a purchase on its way", () => {
  it("shows the steps while pending: paid done, the server step in progress", () => {
    render(<ServiceRow row={{ ...GRANT, status: "pending" }} name="VPN" capabilities={[]} />);
    const steps = screen.getByRole("list", { name: "myServices.build.title" });
    expect(steps.querySelector('[data-step="paid"]')?.getAttribute("data-state")).toBe("done");
    expect(steps.querySelector('[data-step="server"]')?.getAttribute("data-state")).toBe("current");
    expect(steps.querySelector('[data-step="links"]')?.getAttribute("data-state")).toBe("todo");
    // No meter for a period that has not started.
    expect(screen.queryByText("myServices.meter.traffic")).toBeNull();
  });

  it("moves to the links step once delivered and still waiting for lines, then says ready", async () => {
    vi.mocked(billingApi.grantConfigs).mockResolvedValue({ grantId: "g1", rows: [CONFIG] });
    const { rerender } = render(<ServiceRow row={{ ...GRANT, status: "pending" }} name="VPN" capabilities={[]} autoOpen />);
    rerender(<ServiceRow row={GRANT} name="VPN" capabilities={[]} autoOpen />);
    await waitFor(() =>
      expect(document.querySelector('[data-step="links"]')?.getAttribute("data-state")).toBe("current"),
    );

    vi.mocked(billingApi.grantConfigs).mockResolvedValue({
      grantId: "g1",
      rows: [{ ...CONFIG, lines: ["vless://x#DE"], linksCapturedAt: "2026-09-27T10:01:00Z" }],
    });
    // `network.grant.linksCaptured` bumps the row's `configsAsked`.
    rerender(<ServiceRow row={GRANT} name="VPN" capabilities={[]} autoOpen configsAsked={1} />);
    expect(await screen.findByText("myServices.build.ready")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "myServices.build.title" })).toBeNull();
  });
});
