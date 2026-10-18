import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLocale } from "@/context/LocaleContext";
import { authApi } from "@/lib/auth-api";
import { tenantApi, type Reseller } from "@/lib/tenant-api";
import type { Choices } from "./_components/ChoicePicker";
import { IdsPicker } from "./_components/IdsPicker";
import { ResellerPicker } from "./_components/ResellerPicker";
import { UsersPicker } from "./_components/UsersPicker";

/**
 * Pickers instead of typed ids (UX-3-a, `contract.coupons.md` rule 14). The
 * coupon, gift batch and discount rule forms still hold the ids as text and
 * send the same bodies; what changed is how an admin puts an id there — by
 * name, slug or label — with typing kept for a caller whose list read fails.
 */

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
vi.mock("@/hooks/useApiError", () => ({ useApiErrorMessage: () => () => "failed" }));
vi.mock("@/lib/auth-api", async (original) => ({ ...(await original<object>()), authApi: { searchUsers: vi.fn() } }));
vi.mock("@/lib/tenant-api", () => ({ tenantApi: { resellers: vi.fn() } }));

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  vi.mocked(useLocale).mockReturnValue({ lang: "en", isRtl: false, t: (_ns: string, key: string) => key } as unknown as ReturnType<typeof useLocale>);
});

/** The form's own state: the ids as one line each, exactly as before. */
function Text({ initial = "", render: draw }: { initial?: string; render: (value: string, onChange: (v: string) => void) => React.ReactNode }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      {draw(value, setValue)}
      <output data-testid="value">{value}</output>
    </>
  );
}
const value = () => screen.getByTestId("value").textContent;

describe("IdsPicker — products and variants", () => {
  const choices: Choices = [
    { value: A, label: "vpn-basic" },
    { value: B, label: "vpn-pro" },
  ];

  it("adds a picked label's id and drops it again, keeping a saved id the list lacks", async () => {
    render(<Text initial={C} render={(v, set) => <IdsPicker id="p" value={v} onChange={set} choices={choices} />} />);
    expect(screen.getByText(C.slice(0, 8))).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /coupons\.form\.picker\.add/ }));
    fireEvent.click(await screen.findByRole("option", { name: "vpn-pro" }));
    expect(value()).toBe(`${C}\n${B}`);
    expect(screen.getByText("vpn-pro")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "coupons.form.picker.remove" })[0]);
    expect(value()).toBe(B);
  });

  it("types ids when the list cannot be read", () => {
    render(<Text render={(v, set) => <IdsPicker id="p" value={v} onChange={set} choices="failed" />} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: `${A}\n` } });
    expect(value()).toBe(`${A}\n`);
  });
});

describe("UsersPicker — named users", () => {
  it("adds a found user by name, once", async () => {
    vi.mocked(authApi.searchUsers).mockResolvedValue({ users: [{ id: A, fullName: "Sara K", username: "sara", phoneMasked: null }] } as never);
    render(<Text render={(v, set) => <UsersPicker value={v} onChange={set} via="platform" tenantId="" />} />);

    fireEvent.change(screen.getByPlaceholderText("userGroups.members.search"), { target: { value: "sara" } });
    fireEvent.click(await screen.findByRole("button", { name: "userGroups.members.add" }, { timeout: 2000 }));
    expect(value()).toBe(A);
    expect(screen.getAllByText("Sara K").length).toBeGreaterThan(1);
    expect(screen.queryByRole("button", { name: "userGroups.members.add" })).not.toBeInTheDocument();
  });

  it("has only the ids box for a caller with no search door", () => {
    render(<Text render={(v, set) => <UsersPicker value={v} onChange={set} via="ids" tenantId="" />} />);
    expect(screen.queryByPlaceholderText("userGroups.members.search")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: `${A}, ${B}` } });
    expect(value()).toBe(`${A}, ${B}`);
  });
});

describe("ResellerPicker — whose coupon or batch", () => {
  const reseller = (id: string, slug: string, owner: string) => ({ id, slug, owner: { id: "o", fullName: owner, username: owner, phoneNumber: null }, domains: [] }) as unknown as Reseller;

  it("finds a reseller by slug or owner and keeps its id", async () => {
    vi.mocked(tenantApi.resellers).mockResolvedValue([reseller(A, "north-vpn", "Ali"), reseller(B, "south", "Mina")]);
    render(<Text render={(v, set) => <ResellerPicker id="r" value={v} onChange={set} />} />);

    const search = await screen.findByPlaceholderText("coupons.form.resellerPicker.search");
    fireEvent.change(search, { target: { value: "mina" } });
    expect(screen.queryByText("north-vpn")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /south/ }));
    expect(value()).toBe(B);
    expect(screen.getByRole("button", { name: "coupons.form.resellerPicker.change" })).toBeInTheDocument();
  });

  it("falls back to the id when the list cannot be read", async () => {
    vi.mocked(tenantApi.resellers).mockRejectedValue(new Error("403"));
    render(<Text render={(v, set) => <ResellerPicker id="r" value={v} onChange={set} />} />);
    await waitFor(() => expect(screen.getByRole("textbox")).toBeInTheDocument());
    fireEvent.change(screen.getByRole("textbox"), { target: { value: A } });
    expect(value()).toBe(A);
  });
});
