import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { supportApi, type SupportConversation } from "@/lib/support-api";
import { ConfirmProvider } from "../_components/kit/confirm";
import { NewTicketSheet } from "./_components/NewTicketSheet";
import { SupportView } from "./_components/SupportView";
import { TICKET_TABS, readTicketTab, tabCount, tabStatuses } from "./_lib/support";

/**
 * The tickets page (UX-1-w, `contract.ux.md` T2–T3). What breaks quietly:
 *
 * - **a tab that lists one thing and counts another** — "Open" is `open` and
 *   `pending_agent` both, in the query and in its count;
 * - **a filter the browser applies to one page of 30** — the tab and the
 *   search go to the server (UX-1-v) and live in the URL, so a reload or a
 *   shared link shows the same list;
 * - **a category step with nothing to choose** — skipped when the tenant has
 *   none, so the user is never asked an empty question;
 * - **"this solved it" sending anyway** — it closes, and nothing is opened;
 * - **files lost in silence** — they go after the thread opens, and a failure
 *   still opens the thread, saying so.
 */

const K = FrontendI18nKeys.common.support;
const W = FrontendI18nKeys.common.kit.wizard;

let search = new URLSearchParams();
const replace = vi.fn((url: string) => {
  search = new URLSearchParams(url.split("?")[1] ?? "");
});
const push = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => "/support",
  useRouter: () => ({ push, replace }),
  useSearchParams: () => search,
}));
vi.mock("@/context/LocaleContext", () => ({
  useLocale: () => ({
    lang: "en",
    isRtl: false,
    t: (_ns: string, key: string, vars?: Record<string, unknown>) => (vars ? `${key}|${Object.values(vars).join("|")}` : key),
  }),
}));
vi.mock("@/hooks/useApiError", () => ({ useApiErrorMessage: () => (e: unknown) => String(e) }));
vi.mock("@/lib/support-api", async (real) => ({
  ...(await real<typeof import("@/lib/support-api")>()),
  supportApi: {
    list: vi.fn(),
    counts: vi.fn(),
    availability: vi.fn(),
    categories: vi.fn(),
    open: vi.fn(),
    attach: vi.fn(),
  },
}));
vi.mock("@/lib/guide-api", () => ({
  guideReadApi: { forSlot: vi.fn(async () => []), suggest: vi.fn(async () => []), one: vi.fn() },
}));

const api = vi.mocked(supportApi);
const CONV: SupportConversation & { lastLine: string | null } = {
  id: "c-1",
  subject: "Slow connection",
  categoryId: null,
  status: "pending_user",
  mode: "async",
  priority: "normal",
  lastSeq: 2,
  lastMessageAt: "2026-10-05T10:00:00.000Z",
  createdAt: "2026-10-05T09:00:00.000Z",
  unread: 1,
  rating: null,
  lastLine: "We are on it",
};
const COUNTS = { open: 2, pending_agent: 1, pending_user: 3, resolved: 4, closed: 5 };

beforeEach(() => {
  vi.clearAllMocks();
  search = new URLSearchParams();
  api.list.mockResolvedValue({ items: [CONV], nextBefore: null });
  api.counts.mockResolvedValue(COUNTS);
  api.availability.mockRejectedValue(new Error("not needed"));
  api.categories.mockResolvedValue([]);
});

describe("the tabs (T2)", () => {
  it("map each tab to the statuses it lists and counts, and read an unknown tab as All", () => {
    expect(TICKET_TABS).toEqual(["all", "open", "waiting", "resolved", "closed"]);
    expect(tabStatuses("all")).toBeUndefined();
    expect(tabStatuses("open")).toEqual(["open", "pending_agent"]);
    expect(tabStatuses("waiting")).toEqual(["pending_user"]);
    expect(tabCount("all", COUNTS)).toBe(15);
    expect(tabCount("open", COUNTS)).toBe(3);
    expect(tabCount("closed", COUNTS)).toBe(5);
    expect(readTicketTab("bogus")).toBe("all");
    expect(readTicketTab(null)).toBe("all");
  });

  it("asks the server for the tab and the search in the URL, and shows a row's pill, unread dot and last line", async () => {
    search = new URLSearchParams("status=open&q=slow");
    render(
      <ConfirmProvider>
        <SupportView />
      </ConfirmProvider>,
    );
    await waitFor(() => expect(api.list).toHaveBeenCalledWith({ status: ["open", "pending_agent"], q: "slow" }));
    expect(await screen.findByText("We are on it")).toBeTruthy();
    expect(screen.getByText(K.status.pending_user)).toBeTruthy();
    expect(screen.getByLabelText(`${K.unread}|1`)).toBeTruthy();
    // The tab's count is the server's, not the page's.
    expect(screen.getByRole("tab", { name: /open/i }).textContent).toContain("3");
  });

  it("puts the search in the URL 300ms after typing rests, and a single character asks nothing", async () => {
    vi.useFakeTimers();
    try {
      render(
        <ConfirmProvider>
          <SupportView />
        </ConfirmProvider>,
      );
      const box = screen.getByRole("searchbox");
      fireEvent.change(box, { target: { value: "v" } });
      await act(async () => {
        vi.advanceTimersByTime(350);
      });
      expect(replace).not.toHaveBeenCalledWith(expect.stringContaining("q="), expect.anything());
      fireEvent.change(box, { target: { value: "vpn" } });
      await act(async () => {
        vi.advanceTimersByTime(299);
      });
      expect(replace).not.toHaveBeenCalledWith(expect.stringContaining("q=vpn"), expect.anything());
      await act(async () => {
        vi.advanceTimersByTime(2);
      });
      expect(replace).toHaveBeenCalledWith("/support?q=vpn", { scroll: false });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a new ticket (T3)", () => {
  const sheet = (onClose = vi.fn(), onOpened = vi.fn()) => {
    render(
      <ConfirmProvider>
        <NewTicketSheet open onClose={onClose} onOpened={onOpened} />
      </ConfirmProvider>,
    );
    return { onClose, onOpened };
  };
  const writeMessage = async () => fireEvent.change(await screen.findByLabelText(K.form.body), { target: { value: "It stopped working" } });
  const next = () => fireEvent.click(screen.getByRole("button", { name: W.next }));

  it("asks the category first when the tenant has some, and skips it when it has none", async () => {
    api.categories.mockResolvedValue([{ id: "cat-1", key: "connection", name: "Connection" }]);
    sheet();
    expect(await screen.findByRole("radio", { name: "Connection" })).toBeTruthy();
    next();
    expect(await screen.findByText(K.ticket.categoryRequired)).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Connection" }));
    next();
    expect(await screen.findByLabelText(K.form.body)).toBeTruthy();
  });

  it("goes straight to the message with no categories, and will not move on without one", async () => {
    sheet();
    expect(await screen.findByLabelText(K.form.body)).toBeTruthy();
    next();
    expect(await screen.findByText(K.ticket.bodyRequired)).toBeTruthy();
  });

  it('"this solved it" closes and sends nothing', async () => {
    const { onClose, onOpened } = sheet();
    await writeMessage();
    next();
    fireEvent.click(await screen.findByRole("button", { name: K.ticket.solved }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.open).not.toHaveBeenCalled();
    expect(onOpened).not.toHaveBeenCalled();
  });

  it("opens the thread, then attaches the files; a failed attach still opens it, saying so", async () => {
    api.open.mockResolvedValue(CONV);
    api.attach.mockRejectedValue(new Error("too big"));
    const { onOpened } = sheet();
    await writeMessage();
    const png = new File(["x"], "screen.png", { type: "image/png" });
    const exe = new File(["x"], "virus.exe", { type: "application/x-msdownload" });
    fireEvent.change(screen.getByTestId("ticket-files"), { target: { files: [png, exe] } });
    expect(await screen.findByText(`${K.ticket.filesRefused}|virus.exe`)).toBeTruthy();
    next();
    fireEvent.click(await screen.findByRole("button", { name: K.ticket.send }));
    await waitFor(() => expect(onOpened).toHaveBeenCalledWith(CONV, { filesFailed: true }));
    expect(api.open).toHaveBeenCalledWith({ body: "It stopped working", subject: undefined, categoryId: undefined });
    expect(api.attach).toHaveBeenCalledWith("c-1", [png]);
  });
});
