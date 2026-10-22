import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { ApiError } from "@/lib/api-error";
import { billingApi, type ConfigMoveTargets, type UserConfigRow } from "@/lib/billing-api";
import { GrantConfigs } from "./_components/GrantConfigs";
import { moveOfferOf, moveWaitOf, targetOptions } from "./_lib/config-move";

/**
 * «تغییر سرور» on My services (F-410-d over F-410-b/c, panel-web
 * `contract.self-move.md`).
 *
 * > **Offered only where billing would move it**: switched on, and a server to
 * > go to. A `mirror` Grant — on every server already — and a store that
 * > switched it off show nothing.
 *
 * > **The wait is shown, not discovered**: inside it the button is off and
 * > says from when.
 *
 * > **Asked first, then moved; the list re-reads.** The new link arrives by
 * > the capture event the list already listens to — nothing polls.
 */

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
vi.mock("@/lib/billing-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing-api")>()),
  billingApi: { configMoveTargets: vi.fn(), moveConfig: vi.fn(), configAction: vi.fn() },
}));

const M = FrontendI18nKeys.common.myServices.move;
const t = (_ns: string, key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}:${Object.values(vars).join(",")}` : key;

const targetsOf = vi.mocked(billingApi.configMoveTargets);
const move = vi.mocked(billingApi.moveConfig);

const ROW: UserConfigRow = {
  id: "c1",
  protocol: "vless",
  status: "active",
  region: "de",
  allocatedCeilingBytes: null,
  appliedCeilingBytes: null,
  driftState: "synced",
  enforcementState: "complete",
  regenerateUsedCount: 0,
  maxRegenerateCount: 3,
  lastReconciledAt: null,
  label: null,
  lines: [],
  linksCapturedAt: null,
};
const OPEN: ConfigMoveTargets = {
  configId: "c1",
  enabled: true,
  cooldownHours: 24,
  nextMoveAt: null,
  panels: [
    { id: "p-nl", region: "nl" },
    { id: "p-fi", region: "fi" },
  ],
};

function renderList(reload = vi.fn()) {
  render(<GrantConfigs configs={{ rows: [ROW], regenerate: null, readError: null, isLoading: false, reload }} />);
  return reload;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useLocale).mockReturnValue({ lang: "en", t } as ReturnType<typeof useLocale>);
});

describe("what a config offers", () => {
  it("nothing when switched off or with nowhere to go; the wait when inside it; else the servers", () => {
    expect(moveOfferOf(null)).toEqual({ kind: "hidden" });
    expect(moveOfferOf({ ...OPEN, enabled: false })).toEqual({ kind: "hidden" });
    expect(moveOfferOf({ ...OPEN, panels: [] })).toEqual({ kind: "hidden" });
    expect(moveOfferOf({ ...OPEN, nextMoveAt: "2026-10-23T02:00:00.000Z" })).toEqual({ kind: "wait", until: "2026-10-23T02:00:00.000Z" });
    expect(moveOfferOf(OPEN)).toEqual({ kind: "open", panels: OPEN.panels });
  });

  it("names a server by its region, numbered when two share one", () => {
    expect(targetOptions([{ id: "a", region: "de" }, { id: "b", region: "nl" }, { id: "c", region: "de" }])).toEqual([
      { value: "a", label: "de 1" },
      { value: "b", label: "nl" },
      { value: "c", label: "de 2" },
    ]);
  });

  it("reads the wait's end from a `move_cooldown` refusal, and nothing else", () => {
    const cooldown = new ApiError("m", { status: 409, reason: "move_cooldown", facts: { nextAtMs: Date.parse("2026-10-23T02:00:00.000Z") } });
    expect(moveWaitOf(cooldown)).toBe("2026-10-23T02:00:00.000Z");
    expect(moveWaitOf(new ApiError("m", { status: 409, reason: "placed_by_group" }))).toBeNull();
  });
});

describe("the button", () => {
  it("is not there for a Grant with nowhere to go", async () => {
    targetsOf.mockResolvedValue({ ...OPEN, panels: [] });
    renderList();
    await waitFor(() => expect(targetsOf).toHaveBeenCalledWith("c1"));
    expect(screen.queryByRole("button", { name: M.action })).toBeNull();
  });

  it("inside the wait is off and says from when", async () => {
    targetsOf.mockResolvedValue({ ...OPEN, nextMoveAt: "2026-10-23T02:00:00.000Z" });
    renderList();
    expect(await screen.findByRole("button", { name: M.action })).toBeDisabled();
    expect(screen.getByText(new RegExp(`^${M.nextAt}:`))).toBeInTheDocument();
  });

  it("asks which server, moves there, and reads the list again", async () => {
    targetsOf.mockResolvedValue(OPEN);
    move.mockResolvedValue({ retiredConfigId: "c1", configId: "c2", panel: { id: "p-fi", region: "fi" }, nextMoveAt: "2026-10-23T12:00:00.000Z" });
    const reload = renderList();
    fireEvent.click(await screen.findByRole("button", { name: M.action }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText(`${M.wait}:24`)).toBeInTheDocument();
    fireEvent.click(dialog.getByRole("radio", { name: "fi" }));
    fireEvent.click(dialog.getByRole("button", { name: M.confirm }));
    await waitFor(() => expect(move).toHaveBeenCalledWith("c1", "p-fi"));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a refusal inside the wait says from when, and nothing is re-read", async () => {
    targetsOf.mockResolvedValue(OPEN);
    move.mockRejectedValue(new ApiError("m", { status: 409, reason: "move_cooldown", facts: { nextAtMs: Date.parse("2026-10-23T02:00:00.000Z") } }));
    const reload = renderList();
    fireEvent.click(await screen.findByRole("button", { name: M.action }));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.click(dialog.getByRole("button", { name: M.confirm }));
    expect(await dialog.findByText(new RegExp(`^${M.nextAt}:`))).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });
});
