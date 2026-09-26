import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useLocale } from "@/context/LocaleContext";
import { billingApi, type GrantRow } from "@/lib/billing-api";
import { MyServicesView } from "./_components/MyServicesView";
import { useGrantsPage, type GrantsPageState } from "./_hooks/useGrantsPage";

/**
 * Finding a service by one of its configs (F-307-n, over billing's `q`,
 * F-307-m):
 *
 * > **The search is billing's, and it lives in the URL.** `?q=` sits beside
 * > `?page=` and `?all=1`: a search survives a reload and can be sent to
 * > support, and billing answers the page — a page of 20 filtered here would
 * > come back short. A new search starts at page 1; paging and "show ended"
 * > keep it. No match is its own sentence, never "you have no services".
 *
 * The page is rendered over a faked `useGrantsPage`, so what is checked is the
 * query the page asks for and the URL it writes; the hook's own spec checks
 * that the query reaches billing.
 */

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(),
  usePathname: () => "/services",
  useSearchParams: vi.fn(),
}));
vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
vi.mock("@/hooks/useApiError", () => ({ useApiErrorMessage: () => (e: unknown) => String(e) }));
vi.mock("@/lib/billing-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing-api")>()),
  billingApi: { collectionHealth: vi.fn() },
}));
vi.mock("./_hooks/useGrantsPage", () => ({ useGrantsPage: vi.fn() }));
vi.mock("./_components/ServiceRow", () => ({
  ServiceRow: ({ row }: { row: GrantRow }) => <li>{row.id}</li>,
}));

const push = vi.fn();
const replace = vi.fn();
const hook = vi.mocked(useGrantsPage);

function state(over: Partial<GrantsPageState> = {}): GrantsPageState {
  return {
    rows: ["g1", "g2"].map((id) => ({ id, status: "active", variant: null, featureKeys: [] }) as unknown as GrantRow),
    total: 45,
    pageSize: 20,
    hidden: 0,
    texts: {},
    isLoading: false,
    configsAsked: {},
    error: null,
    retry: vi.fn(),
    ...over,
  };
}

function at(query: string) {
  vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams(query) as never);
}

const box = () => screen.getByRole("searchbox", { name: "serviceSearch.label" });

beforeEach(() => {
  vi.useFakeTimers();
  push.mockReset();
  replace.mockReset();
  vi.mocked(useRouter).mockReturnValue({ push, replace } as never);
  vi.mocked(useLocale).mockReturnValue({
    t: (_ns: string, key: string, vars?: Record<string, unknown>) =>
      `${key.replace(/^myServices\./, "")}${vars ? ` ${JSON.stringify(vars)}` : ""}`,
    lang: "en",
  } as never);
  vi.mocked(billingApi.collectionHealth).mockResolvedValue({ metering: "ok" } as never);
  hook.mockReturnValue(state());
});

describe("the page's search (F-307-n)", () => {
  it("asks billing for the URL's query, and shows it in the box", () => {
    at("q=ir-1&page=2");
    render(<MyServicesView />);
    expect(hook).toHaveBeenLastCalledWith(2, "en", "current", "ir-1");
    expect(box()).toHaveValue("ir-1");
  });

  it("writes a new search to the URL once typing stops, back at page 1, keeping ?all", () => {
    at("page=3&all=1");
    render(<MyServicesView />);
    fireEvent.change(box(), { target: { value: " de " } });
    expect(replace).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(400));
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith("/services?all=1&q=de", { scroll: false });
  });

  it("clears to no parameter at all, and Escape clears too", () => {
    at("q=de");
    render(<MyServicesView />);
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(box()).toHaveValue("");
    act(() => vi.advanceTimersByTime(400));
    expect(replace).toHaveBeenCalledWith("/services", { scroll: false });
  });

  it("keeps the search on the next page and on 'show ended'", () => {
    at("q=de");
    hook.mockReturnValue(state({ hidden: 2 }));
    render(<MyServicesView />);
    fireEvent.click(screen.getByRole("button", { name: /showEnded/ }));
    expect(push).toHaveBeenLastCalledWith("/services?all=1&q=de", { scroll: false });
    fireEvent.click(screen.getByRole("button", { name: /goTo.*"2"/ }));
    expect(push).toHaveBeenLastCalledWith("/services?page=2&q=de", { scroll: false });
  });

  it("says no service matched, naming the query, instead of 'no services'", () => {
    at("q=zz");
    hook.mockReturnValue(state({ rows: [], total: 0 }));
    render(<MyServicesView />);
    expect(screen.getByText(/serviceSearch\.none/)).toHaveTextContent('"query":"zz"');
    expect(screen.queryByText(/^empty/)).toBeNull();
    // The box stays, so the search can be changed from the empty answer.
    expect(box()).toHaveValue("zz");
  });

  it("offers no box to a user with no services and no search", () => {
    at("");
    hook.mockReturnValue(state({ rows: [], total: 0 }));
    render(<MyServicesView />);
    expect(screen.queryByRole("searchbox")).toBeNull();
  });
});
