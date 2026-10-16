import { act, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { RealtimeEvents } from "@/generated/wire";
import { usePanelRealtime } from "./_context/PanelRealtimeContext";
import { usePanelSession } from "./_context/PanelSessionContext";
import { useResellerWorkspace } from "./_context/ResellerWorkspaceContext";
import { useHoldsUnsavedEdits } from "./_hooks/useHoldsUnsavedEdits";
import PanelTemplate from "./template";

/**
 * RT-1-m (`realtime/contract.live-events.md`): the tenant's operating currency
 * changed (`tenant.currency.changed` on `members:`), so every figure on the
 * page is in the old currency. The template remounts the page, which re-reads
 * on mount — unless a form on it holds unsaved edits: then the page stays and a
 * banner offers the reload.
 *
 * RT-1-m2: a reseller's workspace is on the platform's panel, so its own change
 * (`tenant.currency.reseller_changed`) reaches the owner on `user:` and the
 * platform's staff on `tenant:` — and remounts only that reseller's pages.
 */

vi.mock("./_context/PanelRealtimeContext", () => ({ usePanelRealtime: vi.fn() }));
vi.mock("./_context/PanelSessionContext", () => ({ usePanelSession: vi.fn() }));
vi.mock("./_context/ResellerWorkspaceContext", () => ({ useResellerWorkspace: vi.fn() }));
vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
vi.mock("@/hooks/useMotionLevel", () => ({ useMotionLevel: () => "reduced" }));

const K = FrontendI18nKeys.common.shell.currencyChanged;

function fakeClient() {
  const fake = {
    channels: [] as string[],
    on: {} as Record<string, (payload: unknown) => void>,
    subscribe: vi.fn((channel: string, options: { onMessage: (p: unknown) => void }) => {
      fake.channels.push(channel);
      fake.on[channel] = options.onMessage;
      return () => {};
    }),
  };
  return fake;
}
let client: ReturnType<typeof fakeClient>;
let mounts = 0;

function Page({ dirty = false }: { dirty?: boolean }) {
  useHoldsUnsavedEdits(dirty);
  useEffect(() => {
    mounts += 1;
  }, []);
  return <p>page</p>;
}

function send(type: string, channel = "members:t-1", body: Record<string, unknown> = { tenantId: "t-1" }) {
  act(() => client.on[channel]!({ type, ...body }));
}

beforeEach(() => {
  vi.useFakeTimers();
  mounts = 0;
  client = fakeClient();
  vi.mocked(usePanelRealtime).mockReturnValue(client as never);
  vi.mocked(usePanelSession).mockReturnValue({ me: { tenant: { id: "t-1" }, permissions: ["*"] }, group: { current: { userId: "u-1" } } } as never);
  vi.mocked(useResellerWorkspace).mockReturnValue({ workspace: null, inPath: false } as never);
  vi.mocked(useLocale).mockReturnValue({ t: (_ns: string, key: string) => key } as unknown as ReturnType<typeof useLocale>);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PanelTemplate on a currency change", () => {
  it("listens on the session tenant's members channel", () => {
    render(<PanelTemplate><Page /></PanelTemplate>);
    expect(client.channels).toEqual(["members:t-1"]);
  });

  it("remounts the page on tenant.currency.changed, so it re-reads", () => {
    render(<PanelTemplate><Page /></PanelTemplate>);
    expect(mounts).toBe(1);
    send(RealtimeEvents.tenantCurrencyChanged);
    expect(mounts).toBe(2);
  });

  it("ignores every other type on the channel", () => {
    render(<PanelTemplate><Page /></PanelTemplate>);
    send(RealtimeEvents.paymentConfirmed);
    expect(mounts).toBe(1);
  });

  it("waits while a form holds unsaved edits, and reloads from the banner", () => {
    render(<PanelTemplate><Page dirty /></PanelTemplate>);
    send(RealtimeEvents.tenantCurrencyChanged);
    expect(mounts).toBe(1);
    expect(screen.getByText(K.title)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: K.reload }));
    expect(mounts).toBe(2);
    expect(screen.queryByText(K.title)).toBeNull();
  });

  it("subscribes to nothing before the session knows its tenant", () => {
    vi.mocked(usePanelSession).mockReturnValue({ me: null } as never);
    render(<PanelTemplate><Page /></PanelTemplate>);
    expect(client.channels).toEqual([]);
  });
});

describe("PanelTemplate on a reseller's currency change (RT-1-m2)", () => {
  const RESELLER = RealtimeEvents.tenantResellerCurrencyChanged;

  it("hears it on the owner's and the platform's channels while that workspace is open", () => {
    vi.mocked(useResellerWorkspace).mockReturnValue({ workspace: { id: "r-1", self: false }, inPath: true } as never);
    render(<PanelTemplate><Page /></PanelTemplate>);
    expect(client.channels).toEqual(["members:t-1", "user:u-1", "tenant:t-1"]);

    send(RESELLER, "user:u-1", { resellerId: "r-1" });
    expect(mounts).toBe(2);
  });

  it("leaves another reseller's workspace alone", () => {
    vi.mocked(useResellerWorkspace).mockReturnValue({ workspace: { id: "r-1", self: false }, inPath: true } as never);
    render(<PanelTemplate><Page /></PanelTemplate>);
    send(RESELLER, "tenant:t-1", { resellerId: "r-2" });
    expect(mounts).toBe(1);
  });

  it("listens for no reseller on a page outside a workspace", () => {
    vi.mocked(useResellerWorkspace).mockReturnValue({ workspace: { id: "r-1", self: true }, inPath: false } as never);
    render(<PanelTemplate><Page /></PanelTemplate>);
    expect(client.channels).toEqual(["members:t-1"]);
  });
});
