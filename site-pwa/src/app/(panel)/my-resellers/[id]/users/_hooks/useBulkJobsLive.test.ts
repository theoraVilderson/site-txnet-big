import { RealtimeEvents } from "@/generated/wire";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useBulkJobsLive } from "./useBulkJobsLive";
import { usePanelSession } from "../../../../_context/PanelSessionContext";
import { usePanelRealtime } from "../../../../_context/PanelRealtimeContext";
import { tenantChannel, userChannel } from "@/lib/realtime";

/**
 * BulkByFilter hears its jobs move instead of polling (RT-1-d, C-14): billing
 * announces each batch, end and cancel on the job tenant's `tenant:`, the
 * platform's `tenant:` and the owner's `user:`. The page listens on the
 * viewer's own two and re-reads only for the tenant it shows.
 */

vi.mock("../../../../_context/PanelSessionContext", () => ({ usePanelSession: vi.fn() }));
vi.mock("../../../../_context/PanelRealtimeContext", () => ({ usePanelRealtime: vi.fn() }));

const RESELLER = "r-1";
const listeners = new Map<string, (payload: unknown) => void>();
const client = {
  subscribe: vi.fn((channel: string, options: { onMessage: (p: unknown) => void }) => {
    listeners.set(channel, options.onMessage);
    return () => listeners.delete(channel);
  }),
};

function signedIn(permissions: string[]) {
  vi.mocked(usePanelSession).mockReturnValue({ me: { tenant: { id: "platform" }, permissions }, group: { current: { userId: "u-1" } } } as never);
}
function emit(channel: string, payload: Record<string, unknown>) {
  act(() => listeners.get(channel)?.(payload));
}

beforeEach(() => {
  vi.clearAllMocks();
  listeners.clear();
  vi.mocked(usePanelRealtime).mockReturnValue(client as never);
  signedIn(["realtime.tenant.read"]);
});

describe("useBulkJobsLive", () => {
  it("re-reads on progress for this tenant, on the viewer's user: and tenant: alike", () => {
    const reread = vi.fn();
    renderHook(() => useBulkJobsLive(RESELLER, reread));
    expect([...listeners.keys()].sort()).toEqual([tenantChannel("platform"), userChannel("u-1")].sort());

    emit(userChannel("u-1"), { type: RealtimeEvents.grantBulkProgressed, resellerId: RESELLER, jobId: "j-1" });
    expect(reread).toHaveBeenCalledTimes(1);
  });

  it("ignores another reseller's job and other events", () => {
    const reread = vi.fn();
    renderHook(() => useBulkJobsLive(RESELLER, reread));
    emit(tenantChannel("platform"), { type: RealtimeEvents.grantBulkProgressed, resellerId: "r-2", jobId: "j-2" });
    emit(tenantChannel("platform"), { type: RealtimeEvents.paymentOpenChanged, resellerId: RESELLER });
    expect(reread).not.toHaveBeenCalled();
  });

  it("holds no tenant: channel for a viewer the gateway would refuse it", () => {
    signedIn([]);
    renderHook(() => useBulkJobsLive(RESELLER, vi.fn()));
    expect([...listeners.keys()]).toEqual([userChannel("u-1")]);
  });
});
