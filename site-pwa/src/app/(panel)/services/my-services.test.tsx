import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocale } from "@/context/LocaleContext";
import { billingApi, type GrantRow } from "@/lib/billing-api";
import { ApiError } from "@/lib/api-error";
import { ServiceRow } from "./_components/ServiceRow";
import { GRANT_STATUSES, GRANT_TONES } from "./_lib/my-services";

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

function statusesBillingCanAnswer(): string[] {
  const block = /enum GrantStatus \{([\s\S]*?)\}/.exec(readFileSync(ENTITLEMENT_PRISMA, "utf8"));
  if (!block) throw new Error("GrantStatus is no longer an enum in entitlement.prisma — this test is stale");
  return block[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[a-z_]+$/.test(line));
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
  billingApi: { rotateGrantToken: vi.fn() },
}));

const rotateGrantToken = vi.mocked(billingApi.rotateGrantToken);

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
