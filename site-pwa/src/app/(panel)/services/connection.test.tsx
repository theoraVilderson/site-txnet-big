import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocale } from "@/context/LocaleContext";
import { billingApi, type GrantRow, type GrantUsage, type UserConfigRow } from "@/lib/billing-api";
import { copyText } from "../_lib/clipboard";
import { ServiceRow } from "./_components/ServiceRow";
import { lineLabel, wireguardConf } from "./_lib/config-lines";
import { dayBars, usedShare } from "./_lib/usage";

/**
 * My services, redesigned (F-307-c, then user 2026-09-26): "connect" is the
 * one strong button on a row, and the things about it that break silently.
 *
 * > **A `.conf` is offered only where it is a whole WireGuard config.** The
 * > file is built in the browser from the `wireguard://` line; a line missing
 * > the peer key or the address would download a file the app imports and
 * > then never connects with — worse than no button.
 *
 * > **Bytes stay exact past 2^53.** The ring and the bars are drawn from
 * > decimal strings; a float that rounded would draw a full ring for a Grant
 * > with bytes left.
 *
 * > **No lines is two different answers.** Not captured yet is a wait; a
 * > panel that gives none sends the user to the subscription link.
 */

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
vi.mock("../_lib/clipboard", () => ({ copyText: vi.fn(async () => true) }));
vi.mock("@/lib/billing-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing-api")>()),
  billingApi: {
    subscriptionLink: vi.fn(),
    resetSubscriptionLink: vi.fn(),
    grantConfigs: vi.fn(),
    grantUsage: vi.fn(),
    configAction: vi.fn(),
  },
}));

const grantConfigs = vi.mocked(billingApi.grantConfigs);
const grantUsage = vi.mocked(billingApi.grantUsage);
const subscriptionLink = vi.mocked(billingApi.subscriptionLink);

const t = (_ns: string, key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}:${Object.values(vars).join(",")}` : key;

const WG =
  "wireguard://cHJpdmF0ZUtleQ%3D%3D@wg.example.net:51820?publickey=cGVlclB1YmxpYw%3D%3D&address=10.8.0.2%2F32%2Cfd00%3A%3A2%2F128&mtu=1280#DE%20WG";
const VLESS = "vless://11111111-2222-3333-4444-555555555555@de.example.net:443?security=reality#DE%20Reality";

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
  lines: [VLESS],
  linksCapturedAt: "2026-09-26T00:00:00.000Z",
};

const GRANT: GrantRow = {
  id: "g1",
  status: "active",
  startsAt: "2026-09-01T00:00:00.000Z",
  endsAt: null,
  featureKeys: [],
  variant: null,
  billingMode: "metered",
  consumedBytes: "1610612736",
  purchasedBytes: "2147483648",
  trafficUnlimited: false,
  trafficCapBytes: null,
  suspendedAt: null,
  purgeAt: null,
};

function usage(days: { uploadBytes: string; downloadBytes: string }[]): GrantUsage {
  return {
    grantId: "g1",
    from: "2026-08-28",
    to: "2026-09-26",
    days: days.map((d, i) => ({
      date: `2026-09-${String(i + 1).padStart(2, "0")}`,
      ...d,
    })),
  };
}

const ZERO = { uploadBytes: "0", downloadBytes: "0" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useLocale).mockReturnValue({ lang: "en", t } as ReturnType<typeof useLocale>);
  grantUsage.mockResolvedValue(usage(Array.from({ length: 30 }, () => ZERO)));
});

describe("a wireguard:// line as a file", () => {
  it("is a whole WireGuard config: interface from the line, the peer at its endpoint", () => {
    expect(wireguardConf(WG)).toBe(
      [
        "[Interface]",
        "PrivateKey = cHJpdmF0ZUtleQ==",
        "Address = 10.8.0.2/32, fd00::2/128",
        "MTU = 1280",
        "",
        "[Peer]",
        "PublicKey = cGVlclB1YmxpYw==",
        "AllowedIPs = 0.0.0.0/0, ::/0",
        "Endpoint = wg.example.net:51820",
        "",
      ].join("\n"),
    );
  });

  it("is no file at all when the line cannot make a working one", () => {
    // The sub-service's own fixture: a key and an endpoint, no peer, no address.
    expect(wireguardConf("wireguard://key@wg.example.net:51820#WG")).toBeNull();
    expect(wireguardConf(WG.replace("address=", "x="))).toBeNull();
    expect(wireguardConf(VLESS)).toBeNull();
    expect(wireguardConf("not a link")).toBeNull();
  });

  it("is named by the line's own name, else its protocol", () => {
    expect(lineLabel(WG)).toBe("DE WG");
    expect(lineLabel("trojan://pw@h:443")).toBe("trojan");
  });
});

describe("the bytes behind the ring and the bars", () => {
  it("stay exact past 2^53, and a ring never passes full", () => {
    // 2^60 bought, 2^60 - 1 used: a float would call this full.
    expect(usedShare("1152921504606846975", "1152921504606846976")).toBeLessThan(1);
    expect(usedShare("5", "4")).toBe(1);
    expect(usedShare("0", "0")).toBeNull();
  });

  it("draws a bar per day against the busiest one, and an empty day as nothing", () => {
    const bars = dayBars(
      usage([
        { uploadBytes: "9007199254740993", downloadBytes: "9007199254740993" },
        { uploadBytes: "0", downloadBytes: "9007199254740993" },
        ZERO,
      ]).days,
    );
    expect(bars.map((b) => b.height)).toEqual([1, 0.5, 0]);
    expect(bars[0].totalBytes).toBe("18014398509481986");
    expect(dayBars(usage([ZERO, ZERO]).days).every((b) => b.height === 0)).toBe(true);
  });

  it("puts the used share on the row without a read", () => {
    render(<ServiceRow row={GRANT} name="VPN" capabilities={[]} />);
    expect(screen.getByRole("img", { name: /myServices\.ring\.label/ })).toBeInTheDocument();
    expect(grantUsage).not.toHaveBeenCalled();
    expect(grantConfigs).not.toHaveBeenCalled();
  });
});

/** A row with its configs open (as the page opens a live one), or its manage fold. */
async function openRow(rows: UserConfigRow[], half: "configs" | "manage" = "configs") {
  grantConfigs.mockResolvedValue({ grantId: "g1", rows });
  const user = userEvent.setup();
  const view = render(<ServiceRow row={GRANT} name="VPN" capabilities={[]} autoOpen={half === "configs"} />);
  if (half === "manage") await user.click(screen.getByRole("button", { name: "myServices.manage.open" }));
  await waitFor(() => expect(screen.queryByText("myServices.configs.loading")).not.toBeInTheDocument());
  return { user, ...view };
}

describe("a row's configs", () => {
  const open = async (rows: UserConfigRow[]) => (await openRow(rows)).user;

  it("reads the 30 days only under manage, and draws 30 bars", async () => {
    await openRow([CONFIG], "manage");
    await waitFor(() => expect(grantUsage).toHaveBeenCalledWith("g1"));
    const chart = await screen.findByRole("img", {
      name: /myServices\.chart\.label/,
    });
    expect(chart.querySelectorAll("[data-day]")).toHaveLength(30);
  });

  it("offers nothing that changes a server: no new link, no delete, no reset", async () => {
    await open([CONFIG]);
    expect(grantUsage).not.toHaveBeenCalled();
    for (const name of ["myServices.configs.regenerate", "myServices.configs.retire", "myServices.link.reset"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });

  it("copies one line, and shows that line's QR", async () => {
    const user = await open([{ ...CONFIG, lines: [VLESS, WG] }]);
    const lines = screen.getAllByRole("listitem").filter((li) => li.hasAttribute("data-line"));
    expect(lines).toHaveLength(2);

    await user.click(within(lines[1]).getByRole("button", { name: "myServices.lines.copy" }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(WG));

    await user.click(within(lines[0]).getByRole("button", { name: "myServices.lines.showQr" }));
    // The QR is a dialog over the page, not a block pushing the list around.
    expect(within(screen.getByRole("dialog")).getByText(VLESS)).toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: "myServices.lines.qrLabel:DE Reality",
      }),
    ).toBeInTheDocument();
    // The link is not read for a line: the line is already the config.
    expect(subscriptionLink).not.toHaveBeenCalled();
  });

  it("copies every line at once, one per line", async () => {
    const user = await open([{ ...CONFIG, lines: [VLESS] }, { ...CONFIG, id: "c2", lines: [WG] }]);
    await user.click(screen.getByRole("button", { name: "myServices.lines.copyAll" }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(`${VLESS}\n${WG}`));
  });

  it("opens with one tap on a row the page did not open", async () => {
    grantConfigs.mockResolvedValue({ grantId: "g1", rows: [CONFIG] });
    const user = userEvent.setup();
    render(<ServiceRow row={GRANT} name="VPN" capabilities={[]} />);
    expect(grantConfigs).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "myServices.configs.show" }));
    expect(await screen.findByRole("button", { name: "myServices.lines.copy" })).toBeInTheDocument();
  });

  it("offers a .conf only for a wireguard line that makes a whole file", async () => {
    await open([
      {
        ...CONFIG,
        lines: [VLESS, WG, "wireguard://key@wg.example.net:51820#Bare"],
      },
    ]);
    const downloads = screen.getAllByRole("link", {
      name: /myServices\.lines\.download/,
    });
    expect(downloads).toHaveLength(1);
    expect(downloads[0]).toHaveAttribute("download", "DE WG.conf");
  });

  it("tells a wait from a panel that gives no lines", async () => {
    await open([
      { ...CONFIG, lines: [], linksCapturedAt: null },
      {
        ...CONFIG,
        id: "c2",
        region: "de-fra-2",
        lines: [],
        linksCapturedAt: "2026-09-26T00:00:00.000Z",
      },
    ]);
    expect(screen.getByText("myServices.lines.notCaptured")).toBeInTheDocument();
    expect(screen.getByText("myServices.lines.none")).toBeInTheDocument();
  });
});

describe("a config list told its lines are captured (F-111-l)", () => {
  const WAITING = { ...CONFIG, lines: [], linksCapturedAt: null };

  const row = (asked: number, open = true) => (
    <ServiceRow row={GRANT} name="VPN" capabilities={[]} configsAsked={asked} autoOpen={open} />
  );

  it("re-reads when its count moves, keeping the list up while it asks", async () => {
    const { rerender } = await openRow([WAITING]);
    await screen.findByText("myServices.lines.notCaptured");

    grantConfigs.mockResolvedValue({ grantId: "g1", rows: [{ ...CONFIG, lines: [VLESS] }] });
    rerender(row(1));
    // No skeleton over the card while it is asked again.
    expect(screen.getByText("myServices.lines.notCaptured")).toBeInTheDocument();

    await waitFor(() => expect(screen.queryByText("myServices.lines.notCaptured")).not.toBeInTheDocument());
    expect(screen.getAllByRole("listitem").filter((li) => li.hasAttribute("data-line"))).toHaveLength(1);
    expect(grantConfigs).toHaveBeenCalledTimes(2);
  });

  it("keeps what it shows when that read fails", async () => {
    const { rerender } = await openRow([WAITING]);
    await screen.findByText("myServices.lines.notCaptured");

    grantConfigs.mockRejectedValue(new Error("down"));
    rerender(row(1));
    await waitFor(() => expect(grantConfigs).toHaveBeenCalledTimes(2));
    expect(screen.getByText("myServices.lines.notCaptured")).toBeInTheDocument();
  });

  it("reads nothing while closed", () => {
    const { rerender } = render(row(0, false));
    rerender(row(3, false));
    expect(grantConfigs).not.toHaveBeenCalled();
  });
});

describe("the subscription link row", () => {
  it("is on every row, and read only when a copy or the QR needs it", () => {
    render(<ServiceRow row={GRANT} name="VPN" capabilities={[]} />);
    expect(screen.getByRole("button", { name: "myServices.link.copy" })).toBeEnabled();
    expect(subscriptionLink).not.toHaveBeenCalled();
  });
});
