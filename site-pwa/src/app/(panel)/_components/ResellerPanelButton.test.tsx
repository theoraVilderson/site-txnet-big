import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ResellerPanelButton } from "./ResellerPanelButton";

/**
 * "My reseller panel" (F-061-f) on the reseller's own domain (F-061-m): there
 * is nowhere to hand off to, so the entry opens the reseller's console here.
 * Before, it minted a code for this same origin and reloaded into the same
 * page — the console, the only way into domains, gateways and the bot, was
 * unreachable from the domain the owner administers it from.
 */

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/context/LocaleContext", () => ({
  useLocale: () => ({ t: (_ns: string, key: string, vars?: { slug?: string }) => `${key}|${vars?.slug}` }),
}));
const issueHandoff = vi.fn();
vi.mock("@/lib/auth-api", () => ({ authApi: { issueHandoff: (id: string) => issueHandoff(id) } }));

const assign = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, "location", { value: { assign }, writable: true });
  issueHandoff.mockResolvedValue({ origin: "https://arianvpn.ir", code: "c0de", expiresIn: 60 });
});

describe("ResellerPanelButton", () => {
  it("opens the console of the reseller whose domain this is, with no handoff", async () => {
    render(<ResellerPanelButton resellers={[{ id: "r-1", slug: "arian", here: true }]} />);

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/my-resellers/r-1"));
    expect(issueHandoff).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it("still hands off to a reseller whose domain this is not", async () => {
    render(<ResellerPanelButton resellers={[{ id: "r-1", slug: "arian", here: false }]} />);

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://arianvpn.ir/auth/handoff#c0de"));
    expect(push).not.toHaveBeenCalled();
  });
});
