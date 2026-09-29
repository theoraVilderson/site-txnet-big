import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useLocale } from "@/context/LocaleContext";
import { billingApi, type GrantRow } from "@/lib/billing-api";
import { MyServicesView } from "./_components/MyServicesView";
import { useGrantsPage, type GrantsPageState } from "./_hooks/useGrantsPage";
import { pastedLines } from "./_lib/my-services";

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
// The wallet strip (F-118-j) reads the panel session; this suite is about the search.
vi.mock("../_hooks/useWalletBalance", () => ({
  useWalletBalance: () => ({ balance: null, held: null, available: null, currencyCode: null, isLoading: true, failed: false, refresh: () => {} }),
}));
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
    expect(hook).toHaveBeenLastCalledWith(2, "en", "current", "ir-1", []);
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

  it("keeps what is typed while the URL catches up, instead of blanking it for a moment", () => {
    at("");
    const { rerender } = render(<MyServicesView />);
    fireEvent.change(box(), { target: { value: "de" } });
    act(() => vi.advanceTimersByTime(400));
    rerender(<MyServicesView />); // the write has not landed yet
    expect(box()).toHaveValue("de");
    fireEvent.change(box(), { target: { value: "de-1 " } });
    at("q=de"); // the first write lands while a second word is typed
    rerender(<MyServicesView />);
    expect(box()).toHaveValue("de-1 ");
  });

  it("still follows the URL when it moves on its own (back, forward, a link)", () => {
    at("q=de");
    const { rerender } = render(<MyServicesView />);
    at("q=nl");
    rerender(<MyServicesView />);
    expect(box()).toHaveValue("nl");
  });

  it("re-renders only the box while typing, not the list", () => {
    at("");
    render(<MyServicesView />);
    const before = hook.mock.calls.length;
    for (const v of ["d", "de", "de-", "de-1"]) fireEvent.change(box(), { target: { value: v } });
    expect(hook.mock.calls.length).toBe(before);
    expect(box()).toHaveValue("de-1");
  });

  it("offers no box to a user with no services and no search", () => {
    at("");
    hook.mockReturnValue(state({ rows: [], total: 0 }));
    render(<MyServicesView />);
    expect(screen.queryByRole("searchbox")).toBeNull();
  });
});

/**
 * Finding a service by pasting its configs (F-307-q, over billing's
 * `by-lines`, F-307-p):
 *
 * > **A pasted line is a credential, so it never reaches the URL.** The same
 * > box: a paste holding `://` becomes up to 20 lines sent in a POST body,
 * > held by the page alone, and gone on a reload. A URL lands in history and
 * > access logs; `?q=` is for names.
 */
const VLESS = "vless://0f6c1b8e-5b0a-4c47-9d6e-2a4d7f1e9c33@de-1.example.net:443?security=tls#DE%201";
const TROJAN = "trojan://secret@nl-1.example.net:443#NL";

function paste(text: string) {
  fireEvent.paste(box(), { clipboardData: { getData: () => text } });
}

/** Every URL the page wrote, pushed or replaced. */
const written = () => [...push.mock.calls, ...replace.mock.calls].map((c) => String(c[0]));

describe("pasted config links (F-307-q)", () => {
  it("reads the lines that hold ://, one per line or space, each once, and drops what cannot be a config", () => {
    const long = `vless://${"a".repeat(4100)}`;
    expect(pastedLines(`  ${VLESS}\r\n\nnot a link\n${TROJAN} ${VLESS}\n${long}`)).toEqual({
      lines: [VLESS, TROJAN],
      capped: false,
    });
    expect(pastedLines("just a name").lines).toEqual([]);
    const many = Array.from({ length: 23 }, (_, i) => `trojan://s${i}@h:443`);
    expect(pastedLines(many.join("\n"))).toEqual({ lines: many.slice(0, 20), capped: true });
  });

  it("hands billing the pasted lines, writes none of them to the URL, and says how many", () => {
    at("page=2&q=de");
    const { rerender } = render(<MyServicesView />);
    paste(`${VLESS}\n${TROJAN}`);
    // Back to page 1 with the name search dropped; the lines stay in the page.
    expect(replace).toHaveBeenCalledWith("/services", { scroll: false });
    at("");
    rerender(<MyServicesView />);
    expect(hook).toHaveBeenLastCalledWith(1, "en", "current", "", [VLESS, TROJAN]);
    act(() => vi.advanceTimersByTime(400));
    expect(written().some((u) => u.includes("://") || u.includes("vless") || u.includes("q="))).toBe(false);
    expect(box()).toHaveValue("");
    expect(screen.getByText(/serviceSearch\.pasted/)).toHaveTextContent('"count":2');
  });

  it("keeps the lines across paging and 'show ended', still out of the URL", () => {
    at("");
    hook.mockReturnValue(state({ hidden: 2 }));
    const { rerender } = render(<MyServicesView />);
    paste(VLESS);
    fireEvent.click(screen.getByRole("button", { name: /goTo.*"2"/ }));
    expect(push).toHaveBeenLastCalledWith("/services?page=2", { scroll: false });
    at("page=2");
    rerender(<MyServicesView />);
    expect(hook).toHaveBeenLastCalledWith(2, "en", "current", "", [VLESS]);
    fireEvent.click(screen.getByRole("button", { name: /showEnded/ }));
    expect(push).toHaveBeenLastCalledWith("/services?all=1", { scroll: false });
  });

  it("says only the first 20 were searched when more were pasted", () => {
    at("");
    render(<MyServicesView />);
    paste(Array.from({ length: 25 }, (_, i) => `trojan://s${i}@h:443`).join("\n"));
    expect(hook.mock.lastCall?.[4]).toHaveLength(20);
    expect(screen.getByText(/serviceSearch\.pastedCapped/)).toHaveTextContent('"max":20');
  });

  it("says none of the pasted configs is a service of theirs, never 'no services'", () => {
    at("");
    render(<MyServicesView />);
    hook.mockReturnValue(state({ rows: [], total: 0, hidden: 1 }));
    paste(VLESS);
    expect(screen.getByText(/serviceSearch\.pastedNoneCurrent/)).toBeInTheDocument();
    expect(screen.queryByText(/^empty|noCurrent/)).toBeNull();
    expect(screen.queryByText(/0f6c1b8e/)).toBeNull();
  });

  it("is cleared by the clear button, by Escape, and by typing a name", () => {
    at("");
    render(<MyServicesView />);
    paste(VLESS);
    fireEvent.click(screen.getByRole("button", { name: "serviceSearch.clear" }));
    expect(hook).toHaveBeenLastCalledWith(1, "en", "current", "", []);

    paste(VLESS);
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(hook).toHaveBeenLastCalledWith(1, "en", "current", "", []);

    paste(VLESS);
    fireEvent.change(box(), { target: { value: "de" } });
    expect(hook).toHaveBeenLastCalledWith(1, "en", "current", "", []);
  });

  it("takes a subscription link the same way — to billing, never to the URL (F-307-r)", () => {
    const SUB = "https://sub.reseller.example/sub/Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6";
    at("");
    render(<MyServicesView />);
    paste(SUB);
    expect(hook).toHaveBeenLastCalledWith(1, "en", "current", "", [SUB]);
    act(() => vi.advanceTimersByTime(400));
    expect(written().some((u) => u.includes("sub"))).toBe(false);
  });

  it("keeps a paste when a name typed just before it lands in the URL late", () => {
    at("");
    const { rerender } = render(<MyServicesView />);
    fireEvent.change(box(), { target: { value: "de" } });
    act(() => vi.advanceTimersByTime(400)); // ?q=de sent, not landed
    paste(VLESS);
    at("q=de");
    rerender(<MyServicesView />);
    expect(hook).toHaveBeenLastCalledWith(1, "en", "current", "", [VLESS]);
    expect(replace).toHaveBeenLastCalledWith("/services", { scroll: false });
  });

  it("treats a link that arrives without a paste (a drop) the same way", () => {
    at("");
    render(<MyServicesView />);
    fireEvent.change(box(), { target: { value: VLESS } });
    expect(hook).toHaveBeenLastCalledWith(1, "en", "current", "", [VLESS]);
    expect(box()).toHaveValue("");
    act(() => vi.advanceTimersByTime(400));
    expect(written().some((u) => u.includes("vless"))).toBe(false);
  });
});
