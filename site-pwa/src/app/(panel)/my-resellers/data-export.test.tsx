/**
 * «Export my data» on the reseller's settings (F-212-c, tenant
 * `contract.data-export.md`, catalog §14.8).
 *
 * What breaks without anyone seeing it:
 *  - **a staff seat shown a button it is refused.** The routes admit the owner
 *    and platform staff only; a `not_allowed` list hides the card;
 *  - **a second export offered inside the 24 h.** The button is off until the
 *    service's `nextAllowedAt`, and the date is said;
 *  - **a link minted on load.** Each is audited and lives five minutes, so it
 *    is asked for on the click, and only for a `ready` archive;
 *  - **a page that waits for a refresh.** It re-reads on its own
 *    `tenant.data_export.changed`, for this reseller only (C-14).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useLocale } from "@/context/LocaleContext";
import { ApiError } from "@/lib/api-error";
import { RealtimeEvents } from "@/generated/wire";
import { useLiveReread } from "@/hooks/useLiveReread";
import { tenantDataExportApi, type DataExportList, type DataExportView } from "@/lib/tenant-data-export-api";
import { usePanelSession } from "../_context/PanelSessionContext";
import { downloadUrl } from "../_lib/download";
import { DataExportCard } from "./[id]/_components/DataExportCard";
import { DATA_EXPORT_KEYS as K, msUntilNext } from "./_lib/data-export";

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
vi.mock("@/hooks/useLiveReread", () => ({ useLiveReread: vi.fn() }));
vi.mock("@/hooks/useApiError", () => ({ useApiErrorMessage: () => () => "generic" }));
vi.mock("../_context/PanelSessionContext", () => ({ usePanelSession: vi.fn() }));
vi.mock("../_lib/download", () => ({ downloadUrl: vi.fn() }));
vi.mock("@/lib/tenant-data-export-api", () => ({ tenantDataExportApi: { list: vi.fn(), request: vi.fn(), link: vi.fn() } }));

const t = (_ns: string, key: string, vars?: Record<string, string | number>) => (vars ? `${key}:${Object.values(vars).join(",")}` : key);
const RESELLER = "22222222-2222-4222-8222-222222222222";
const OWNER = "33333333-3333-4333-8333-333333333333";
const NOW = Date.parse("2026-10-22T10:00:00Z");

const view = (over: Partial<DataExportView> = {}): DataExportView => ({
  id: "e1",
  status: "ready",
  createdAt: "2026-10-21T09:00:00Z",
  finishedAt: "2026-10-21T09:05:00Z",
  expiresAt: "2026-10-28T09:05:00Z",
  sizeBytes: 2048,
  rowCount: 120,
  ...over,
});
const list = (over: Partial<DataExportList> = {}): DataExportList => ({ exports: [], nextAllowedAt: null, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.mocked(useLocale).mockReturnValue({ t, lang: "en" } as never);
  vi.mocked(usePanelSession).mockReturnValue({ me: { userId: OWNER } } as never);
});

describe("msUntilNext", () => {
  it("is the service's clock: null when open, never negative", () => {
    expect(msUntilNext(null, NOW)).toBeNull();
    expect(msUntilNext("2026-10-22T09:59:59Z", NOW)).toBe(0);
    expect(msUntilNext("2026-10-22T10:00:05Z", NOW)).toBe(5000);
  });
});

describe("DataExportCard", () => {
  it("shows nothing to a caller the routes refuse", async () => {
    vi.mocked(tenantDataExportApi.list).mockRejectedValue(new ApiError("no", { status: 403, reason: "not_allowed" }));
    const { container } = render(<DataExportCard tenantId={RESELLER} />);
    await waitFor(() => expect(tenantDataExportApi.list).toHaveBeenCalledWith(RESELLER));
    await waitFor(() => expect(container.innerHTML).toBe(""));
  });

  it("keeps the button off inside the 24 h and says when", async () => {
    vi.mocked(tenantDataExportApi.list).mockResolvedValue(list({ exports: [view()], nextAllowedAt: "2026-10-22T11:00:00Z" }));
    render(<DataExportCard tenantId={RESELLER} />);
    expect(await screen.findByRole("button", { name: K.request })).toHaveProperty("disabled", true);
    expect(screen.getByText(new RegExp(`^${K.nextAt.replace(".", "\\.")}:`))).toBeTruthy();
  });

  it("asks for an export and reads the list again", async () => {
    vi.mocked(tenantDataExportApi.list).mockResolvedValueOnce(list()).mockResolvedValueOnce(list({ exports: [view({ status: "queued", finishedAt: null, expiresAt: null, sizeBytes: null, rowCount: null })], nextAllowedAt: "2026-10-23T10:00:00Z" }));
    vi.mocked(tenantDataExportApi.request).mockResolvedValue(view({ status: "queued" }));
    render(<DataExportCard tenantId={RESELLER} />);
    fireEvent.click(await screen.findByRole("button", { name: K.request }));
    await waitFor(() => expect(tenantDataExportApi.request).toHaveBeenCalledWith(RESELLER));
    expect(await screen.findByText(K.status.queued)).toBeTruthy();
    expect(tenantDataExportApi.list).toHaveBeenCalledTimes(2);
  });

  it("says a refusal in its own sentence", async () => {
    vi.mocked(tenantDataExportApi.list).mockResolvedValue(list());
    vi.mocked(tenantDataExportApi.request).mockRejectedValue(new ApiError("soon", { status: 429, reason: "export_too_soon" }));
    render(<DataExportCard tenantId={RESELLER} />);
    fireEvent.click(await screen.findByRole("button", { name: K.request }));
    expect(await screen.findByText(K.refusals.export_too_soon)).toBeTruthy();
  });

  it("mints a link on the click, for a ready archive only", async () => {
    vi.mocked(tenantDataExportApi.list).mockResolvedValue(list({ exports: [view(), view({ id: "e0", status: "expired" })] }));
    vi.mocked(tenantDataExportApi.link).mockResolvedValue({ url: "/files/signed?x=1", expiresAt: "2026-10-22T10:05:00Z" });
    render(<DataExportCard tenantId={RESELLER} />);
    const buttons = await screen.findAllByRole("button", { name: K.download });
    expect(buttons).toHaveLength(1);
    expect(tenantDataExportApi.link).not.toHaveBeenCalled();
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(downloadUrl).toHaveBeenCalledWith("/files/signed?x=1"));
    expect(tenantDataExportApi.link).toHaveBeenCalledWith(RESELLER, "e1");
  });

  it("re-reads on its own event, for this reseller only", async () => {
    vi.mocked(tenantDataExportApi.list).mockResolvedValue(list());
    render(<DataExportCard tenantId={RESELLER} />);
    await waitFor(() => expect(tenantDataExportApi.list).toHaveBeenCalledTimes(1));
    const [channel, types, reread, accepts] = vi.mocked(useLiveReread).mock.calls.at(-1)!;
    expect(channel).toBe(`user:${OWNER}`);
    expect(types).toEqual([RealtimeEvents.tenantDataExportChanged]);
    expect(accepts?.({ resellerId: RESELLER })).toBe(true);
    expect(accepts?.({ resellerId: "other" })).toBe(false);
    reread("event");
    await waitFor(() => expect(tenantDataExportApi.list).toHaveBeenCalledTimes(2));
  });
});
