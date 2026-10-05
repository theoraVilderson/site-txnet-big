import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { supportApi, type SupportMessage, type SupportMessagePage } from "@/lib/support-api";
import { JumpToLatest, TypingDots, useFollowLatest } from "./_components/ThreadParts";
import { SupportThreadView } from "./_components/SupportThreadView";
import { awayFromBottom, isSendKey, threadItems } from "./_lib/support";

/**
 * A support thread (UX-1-x, `contract.ux.md` T4), the user's and the agent's.
 * What breaks quietly:
 *
 * - **a day drawn in the wrong zone** — a message at 00:01 in Tehran is the
 *   next day there, whatever UTC says; the separator follows the resolved zone;
 * - **a label on every message** — one sender within 5 minutes is one group,
 *   broken by another sender, a longer pause or a new day;
 * - **Enter sending half a message** — only Ctrl/⌘+Enter sends; Enter is a
 *   line, on a phone's keyboard too (user, 2026-10-05);
 * - **a reader yanked to the bottom** — away by more than 200px, a new
 *   message waits behind a button that counts them; near the bottom it scrolls;
 * - **a screenshot only as a file name** — a clean image is a thumbnail that
 *   opens in a dialog, and a pasted one joins the message.
 */

const K = FrontendI18nKeys.common.support;

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(), usePathname: () => "/support/c-1", useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/context/LocaleContext", () => ({
  useLocale: () => ({
    lang: "en",
    isRtl: false,
    t: (_ns: string, key: string, vars?: Record<string, unknown>) => (vars ? `${key}|${Object.values(vars).join("|")}` : key),
  }),
}));
vi.mock("@/hooks/useApiError", () => ({ useApiErrorMessage: () => (e: unknown) => String(e) }));
vi.mock("../_context/PanelRealtimeContext", () => ({ usePanelRealtime: () => null }));
vi.mock("@/lib/support-api", async (real) => ({
  ...(await real<typeof import("@/lib/support-api")>()),
  supportApi: { messages: vi.fn(), send: vi.fn(), attach: vi.fn(), typing: vi.fn(async () => ({ expiresInMs: 6000 })), read: vi.fn(async () => ({ lastReadSeq: 0 })), rate: vi.fn() },
}));

const api = vi.mocked(supportApi);

const msg = (seq: number, at: string, senderKind = "user", extra: Partial<SupportMessage> = {}): SupportMessage => ({
  id: `m-${seq}`,
  seq,
  senderKind,
  mine: senderKind === "user",
  body: `message ${seq}`,
  createdAt: at,
  attachments: [],
  ...extra,
});

describe("the thread's layout (T4)", () => {
  it("draws a day separator per day in the resolved zone, and groups one sender within 5 minutes", () => {
    const messages = [
      msg(1, "2026-10-04T20:00:00Z"), // 23:30 on the 4th in Tehran
      msg(2, "2026-10-04T20:03:00Z"),
      msg(3, "2026-10-04T20:31:00Z"), // 00:01 on the 5th in Tehran — the 4th in UTC
      msg(4, "2026-10-04T20:33:00Z", "agent"),
      msg(5, "2026-10-04T20:45:00Z", "agent"), // 12 minutes on
    ];
    const items = threadItems(messages, (m) => m.senderKind, "Asia/Tehran").map((i) => (i.kind === "day" ? `day ${i.day}` : `${i.message.seq}${i.first ? " first" : ""}`));
    expect(items).toEqual(["day 2026-10-04", "1 first", "2", "day 2026-10-05", "3 first", "4 first", "5 first"]);
    // In UTC the same five messages are one day.
    expect(threadItems(messages, (m) => m.senderKind, "UTC").filter((i) => i.kind === "day")).toHaveLength(1);
  });

  it("sends on Ctrl/⌘+Enter only — Enter and Shift+Enter are a new line, and so is Enter mid-composition", () => {
    expect(isSendKey({ key: "Enter", ctrlKey: true, metaKey: false })).toBe(true);
    expect(isSendKey({ key: "Enter", ctrlKey: false, metaKey: true })).toBe(true);
    expect(isSendKey({ key: "Enter", ctrlKey: false, metaKey: false })).toBe(false);
    expect(isSendKey({ key: "Enter", ctrlKey: false, metaKey: false, shiftKey: true })).toBe(false);
    expect(isSendKey({ key: "Enter", ctrlKey: true, metaKey: false, isComposing: true })).toBe(false);
  });

  it("is away from the bottom past 200px", () => {
    expect(awayFromBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 400 })).toBe(false);
    expect(awayFromBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 399 })).toBe(true);
  });
});

function Follow({ count }: { count: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const follow = useFollowLatest(ref, count, false);
  return (
    <>
      <div ref={ref} data-testid="scroller" onScroll={follow.onScroll} />
      <JumpToLatest follow={follow} />
    </>
  );
}

const metrics = (el: HTMLElement, scrollTop: number) => {
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: 1000 });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: 400 });
  el.scrollTop = scrollTop;
  el.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
    el.scrollTop = top ?? 0;
  }) as never;
};

describe("following the latest message (T4)", () => {
  it("scrolls to a new message near the bottom; away from it, counts them behind a button that goes there", async () => {
    const { rerender } = render(<Follow count={3} />);
    const scroller = screen.getByTestId("scroller");
    metrics(scroller, 600);
    rerender(<Follow count={4} />);
    expect(scroller.scrollTo).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /jump/i })).toBeNull();

    metrics(scroller, 100);
    fireEvent.scroll(scroller);
    rerender(<Follow count={6} />);
    expect(scroller.scrollTo).not.toHaveBeenCalled();
    const jump = await screen.findByRole("button", { name: new RegExp(K.thread.jumpLatest) });
    expect(jump.textContent).toContain(`${K.thread.jumpNew}|2`);
    fireEvent.click(jump);
    expect(scroller.scrollTo).toHaveBeenCalled();
    fireEvent.scroll(scroller);
    await waitFor(() => expect(screen.queryByRole("button", { name: new RegExp(K.thread.jumpLatest) })).toBeNull());
  });

  it("says typing as three dots, with words for a screen reader", () => {
    render(<TypingDots label="typing" />);
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-label")).toBe("typing");
    expect(status.querySelectorAll("[data-dot]")).toHaveLength(3);
  });
});

describe("the user's thread (T4)", () => {
  const page = (over: Partial<SupportMessagePage["conversation"]> = {}, messages: SupportMessage[] = []): SupportMessagePage => ({
    conversation: {
      id: "c-1",
      subject: "Slow",
      categoryId: null,
      status: "pending_user",
      mode: "async",
      priority: "normal",
      lastSeq: messages.length,
      lastMessageAt: "2026-10-05T10:00:00Z",
      createdAt: "2026-10-05T09:00:00Z",
      unread: 0,
      rating: null,
      ...over,
    },
    messages,
    hasEarlier: false,
    lastReadSeq: messages.length,
    seenUpToSeq: 0,
    realtime: null,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollTo = vi.fn() as never;
  });

  it("shows a clean image as a thumbnail that opens in a dialog", async () => {
    const shot = { id: "a-1", fileName: "screen.png", contentType: "image/png", sizeBytes: 2048, scanStatus: "clean" as const, url: "/f/screen.png", urlExpiresAt: null, expired: false };
    api.messages.mockResolvedValue(page({}, [msg(1, "2026-10-05T09:00:00Z", "agent", { attachments: [shot] })]));
    render(<SupportThreadView id="c-1" />);
    const thumb = await screen.findByRole("button", { name: `${K.thread.imageOpen}: screen.png` });
    fireEvent.click(thumb);
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getAllByRole("img", { name: "screen.png" }).length).toBeGreaterThan(1);
  });

  it("sends on Ctrl+Enter, keeps a line on Enter, and takes a pasted image with the message", async () => {
    api.messages.mockResolvedValue(page());
    api.send.mockResolvedValue(msg(1, "2026-10-05T10:01:00Z"));
    api.attach.mockResolvedValue(msg(2, "2026-10-05T10:02:00Z"));
    render(<SupportThreadView id="c-1" />);
    const box = await screen.findByPlaceholderText(K.thread.placeholder);

    fireEvent.change(box, { target: { value: "hello" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(api.send).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    });
    expect(api.send).toHaveBeenCalledWith("c-1", "hello");

    const png = new File(["x"], "pasted.png", { type: "image/png" });
    fireEvent.change(box, { target: { value: "see this" } });
    fireEvent.paste(box, { clipboardData: { files: [png], types: ["Files"] } });
    expect(await screen.findByRole("button", { name: `${K.thread.removeFile} pasted.png` })).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    });
    expect(api.attach).toHaveBeenCalledWith("c-1", [png], "see this");
  });

  it("rates with five stars once the thread is resolved", async () => {
    api.messages.mockResolvedValue(page({ status: "resolved" }));
    render(<SupportThreadView id="c-1" />);
    const stars = await screen.findAllByRole("radio");
    expect(stars).toHaveLength(5);
    fireEvent.click(stars[3]);
    expect(stars[3].getAttribute("aria-checked")).toBe("true");
  });
});
