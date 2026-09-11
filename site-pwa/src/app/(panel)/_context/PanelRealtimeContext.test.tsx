import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  PanelRealtimeProvider,
  usePanelRealtime,
} from "./PanelRealtimeContext";
import { usePanelSession } from "./PanelSessionContext";
import { authApi } from "@/lib/auth-api";
import { createRealtimeClient, type RealtimeClientOptions } from "@/lib/realtime";
import { AUTH_LOGIN } from "@/lib/routes";

/**
 * The signed-in socket (`F-070-c`). Everything asserted here fails *silently*
 * if it is wrong — there is no error anywhere, only live updates that stop
 * arriving:
 *
 * - **A socket opened before the session is established is anonymous**, and an
 *   anonymous connection is refused every `user:` channel by construction
 *   (`realtime/contract.channels.md`). It connects, it is welcomed, and it
 *   carries nothing.
 * - **The credential is read at connect, not captured at mount.** Refresh
 *   rotates it (F-0209), so a reconnect twenty minutes later offering the
 *   token this provider was born with is refused as a `401` the browser cannot
 *   see (`contract.realtime.md`, rule 5).
 * - **`4401` is the panel's own no-session redirect**, not a reconnect. It is
 *   the one close code that means the marker is gone.
 * - **A switch is a close-and-reopen.** Reusing the client would leave the
 *   previous account's channels declared on a connection the gateway now reads
 *   as someone else.
 */

vi.mock("./PanelSessionContext", () => ({ usePanelSession: vi.fn() }));
vi.mock("@/lib/auth-api", () => ({
  authApi: { getAccessToken: vi.fn(), refresh: vi.fn() },
}));
vi.mock("@/lib/realtime", () => ({ createRealtimeClient: vi.fn() }));

const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));

const session = vi.mocked(usePanelSession);
const makeClient = vi.mocked(createRealtimeClient);
const getAccessToken = vi.mocked(authApi.getAccessToken);
const refresh = vi.mocked(authApi.refresh);

/** A stand-in for `RealtimeClient`; the transport has its own spec. */
function fakeClient() {
  return { connect: vi.fn(), close: vi.fn(), subscribe: vi.fn() };
}

let clients: ReturnType<typeof fakeClient>[];
/** The options the provider handed the most recent client. */
let options: RealtimeClientOptions;

function signedInAs(userId: string | null) {
  session.mockReturnValue({
    group: userId
      ? ({ current: { userId } } as never)
      : null,
    isLoading: false,
    reload: vi.fn(),
  });
}

/** Let the `refresh()` promise settle and its handler run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const wrapper = ({ children }: { children: ReactNode }) => (
  <PanelRealtimeProvider>{children}</PanelRealtimeProvider>
);

beforeEach(() => {
  clients = [];
  makeClient.mockImplementation((opts: RealtimeClientOptions = {}) => {
    options = opts;
    const client = fakeClient();
    clients.push(client);
    return client as never;
  });
  getAccessToken.mockReturnValue("token-1");
  signedInAs("u1");
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("before the session is established", () => {
  it("opens no socket at all", () => {
    signedInAs(null);

    const { result } = renderHook(() => usePanelRealtime(), { wrapper });

    expect(makeClient).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });
});

describe("once there is an account", () => {
  it("connects one socket and hands it to the page", () => {
    const { result } = renderHook(() => usePanelRealtime(), { wrapper });

    expect(makeClient).toHaveBeenCalledTimes(1);
    expect(clients[0].connect).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(clients[0]);
  });

  it("survives a re-render without opening a second socket", () => {
    const { rerender } = renderHook(() => usePanelRealtime(), { wrapper });

    rerender();

    expect(makeClient).toHaveBeenCalledTimes(1);
    expect(clients[0].close).not.toHaveBeenCalled();
  });

  it("reads the credential on every connect, never the one it was born with", () => {
    renderHook(() => usePanelRealtime(), { wrapper });

    expect(options.credential?.()).toBe("token-1");
    getAccessToken.mockReturnValue("token-2");
    expect(options.credential?.()).toBe("token-2");
  });
});

describe("when the gateway says the session is gone", () => {
  it("redirects to the login screen", () => {
    renderHook(() => usePanelRealtime(), { wrapper });

    options.onSessionLost?.();

    expect(replace).toHaveBeenCalledWith(AUTH_LOGIN);
  });
});

describe("when the upgrade was refused before a socket existed", () => {
  it("refreshes the access token and leaves the retry to the client", async () => {
    refresh.mockResolvedValue({ accessToken: "token-2", expiresIn: 900 });
    renderHook(() => usePanelRealtime(), { wrapper });

    options.onCredentialRejected?.();
    await flush();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(clients[0].close).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("ends the session when the refresh cookie is gone too", async () => {
    refresh.mockRejectedValue(new Error("no session"));
    renderHook(() => usePanelRealtime(), { wrapper });

    options.onCredentialRejected?.();
    await flush();

    expect(replace).toHaveBeenCalledWith(AUTH_LOGIN);
    expect(clients[0].close).toHaveBeenCalled();
  });
});

describe("when the account switcher changes who this browser is", () => {
  it("closes the socket and opens a new one", () => {
    const { rerender } = renderHook(() => usePanelRealtime(), { wrapper });

    signedInAs("u2");
    rerender();

    expect(clients[0].close).toHaveBeenCalledTimes(1);
    expect(makeClient).toHaveBeenCalledTimes(2);
    expect(clients[1].connect).toHaveBeenCalledTimes(1);
  });

  it("closes the socket when the panel unmounts", () => {
    const { unmount } = renderHook(() => usePanelRealtime(), { wrapper });

    unmount();

    expect(clients[0].close).toHaveBeenCalledTimes(1);
  });
});
