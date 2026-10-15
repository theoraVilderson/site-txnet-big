/**
 * The admin's side of a freeze (F-0401-f, over billing F-0401-b and F-0401-d;
 * `panel-web/contract.reseller-users.md`):
 *
 *  - **hard or soft, single and bulk.** No mode is billing's `hard`; the
 *    panel always says which, so what the admin picked is what is sent;
 *  - **the mode of a frozen Grant changes in place** — `PUT …/freeze-mode`,
 *    offered only on a frozen Grant, never on one stopped by its quota;
 *  - **the history says who froze it and how** — the user's own acts by name,
 *    an admin's freeze with its mode;
 *  - **the reseller's two switches**, read and saved whole.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { FREEZE_MODES, grantLimitsApi, type GrantHistoryRow, type GrantRow, type ResellerUserGrantsApi } from "@/lib/billing-api";
import { FreezeSettingsCard } from "./_components/FreezeSettingsCard";
import { GrantActions } from "./[id]/users/[userId]/_components/GrantActions";
import { GrantHistory } from "./[id]/users/[userId]/_components/GrantHistory";
import { GRANT_ACTION_METHODS, GRANT_ACTION_ROUTES, emptyDraft, grantActionBody, grantActionsOf, type GrantActionDraft } from "./_lib/grant-actions";
import { bulkBody, historyFreezeMode } from "./_lib/grant-bulk";

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
vi.mock("@/lib/billing-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing-api")>()),
  grantLimitsApi: vi.fn(),
}));
// Its stylesheet is not for jsdom; the freeze's end is `grantActionBody`'s, proved above.
vi.mock("../_components/kit/DatePicker", () => ({ DatePicker: () => null }));

const REPO = join(__dirname, "../../../../..");
const source = (rel: string) => readFileSync(join(REPO, rel), "utf8");
const G = FrontendI18nKeys.common.resellerUsers.grant;
const H = FrontendI18nKeys.common.resellerUsers.history;
const FS = FrontendI18nKeys.common.resellerUsers.freezeSettings;
const t = (_ns: string, key: string, vars?: Record<string, string | number>) => (vars ? `${key}:${Object.values(vars).join(",")}` : key);

const NOW = new Date("2026-10-15T10:00:00Z");
const draft = (over: Partial<GrantActionDraft>): GrantActionDraft => ({ ...emptyDraft(), requestId: "0b7c7c1e-1d4f-4a55-9d58-2f3a3c9a9f10", ...over });

const ROW: GrantRow = {
  id: "g-1",
  label: null,
  status: "active",
  startsAt: "2026-10-01T00:00:00Z",
  endsAt: "2026-11-01T00:00:00Z",
  featureKeys: [],
  variant: null,
  billingMode: "prepaid",
  consumedBytes: "0",
  purchasedBytes: "10737418240",
  trafficUnlimited: false,
  trafficCapBytes: "10737418240",
  suspendedAt: null,
  purgeAt: null,
  lastTrafficAt: null,
  frozen: false,
  frozenUntil: null,
  freezeMode: null,
  userMayUnfreeze: false,
};
const FROZEN: GrantRow = { ...ROW, status: "suspended", frozen: true, freezeMode: "hard" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useLocale).mockReturnValue({ lang: "en", t } as ReturnType<typeof useLocale>);
});

describe("a freeze's mode", () => {
  it("is the one entitlement declares", () => {
    const prisma = source("txnet-backend/prisma/domains/entitlement.prisma");
    const declared = /enum FreezeMode \{([^}]*)\}/.exec(prisma)?.[1].match(/^\s*([a-z]+)\s*$/gm)?.map((m) => m.trim());
    expect([...FREEZE_MODES]).toEqual(declared);
  });

  it("is always sent: hard unless the admin picked soft, alone or with an end", () => {
    expect(grantActionBody("freeze", draft({}), NOW)).toEqual({ mode: "hard" });
    expect(grantActionBody("freeze", draft({ freezeMode: "soft", reason: "r" }), NOW)).toEqual({ mode: "soft", reason: "r" });
    const until = grantActionBody("freeze", draft({ freezeMode: "soft", until: "2026-10-20" }), NOW);
    expect(until).toMatchObject({ mode: "soft", until: expect.any(String) });
  });

  it("rides the bulk's freeze too", () => {
    expect(bulkBody("freeze", ["g-1"], draft({ freezeMode: "soft", reason: "r" }), NOW)).toMatchObject({ action: "freeze", mode: "soft" });
  });
});

describe("changing a frozen Grant's mode", () => {
  it("is billing's PUT …/freeze-mode, with the mode and an optional reason", () => {
    const controller = source("txnet-backend/billing-service/src/app/payment/gift/reseller-grant-freeze.controller.ts");
    expect(controller).toContain(`@Put('${GRANT_ACTION_ROUTES.freezeMode}')`);
    expect(GRANT_ACTION_METHODS.freezeMode).toBe("PUT");
    expect(GRANT_ACTION_METHODS.freeze).toBe("POST");
    expect(grantActionBody("freezeMode", draft({ freezeMode: "soft" }), NOW)).toEqual({ mode: "soft" });
  });

  it("is offered on a frozen Grant only — not one its quota stopped", () => {
    expect(grantActionsOf(FROZEN)).toEqual(expect.arrayContaining(["unfreeze", "freezeMode"]));
    expect(grantActionsOf({ ...FROZEN, frozen: false })).not.toContain("freezeMode");
    expect(grantActionsOf(ROW)).not.toContain("freezeMode");
  });

  it("opens on the other mode, and sends it with PUT", async () => {
    const grantAction = vi.fn().mockResolvedValue({ grantId: "g-1", freezeModeBefore: "hard", freezeMode: "soft" });
    render(<GrantActions api={{ grantAction } as unknown as ResellerUserGrantsApi} row={FROZEN} onActed={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: G.label.freezeMode }));
    expect((screen.getByRole("radio", { name: G.field.modeSoft }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: G.submit.freezeMode }));
    await waitFor(() => expect(grantAction).toHaveBeenCalledWith("g-1", "freeze-mode", { mode: "soft" }, "PUT"));
    expect((await screen.findByRole("status")).textContent).toContain(G.done.freezeModeSoft);
  });

  it("lets the admin pick soft on a fresh freeze", async () => {
    const grantAction = vi.fn().mockResolvedValue({ grantId: "g-1", configsDisabled: 1, freezeMode: "soft" });
    render(<GrantActions api={{ grantAction } as unknown as ResellerUserGrantsApi} row={ROW} onActed={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: G.label.freeze }));
    expect((screen.getByRole("radio", { name: G.field.modeHard }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: G.field.modeSoft }));
    fireEvent.click(screen.getByRole("button", { name: G.submit.freeze }));
    await waitFor(() => expect(grantAction).toHaveBeenCalledWith("g-1", "freeze", { mode: "soft" }, "POST"));
  });
});

describe("the history", () => {
  const entry = (over: Partial<GrantHistoryRow>): GrantHistoryRow => ({
    id: "a-1",
    action: "grant_freeze",
    targetType: "grant",
    targetId: "g-1",
    actorUserId: "aaaaaaaa-0000-4000-8000-000000000000",
    before: { freezeMode: null },
    after: { freezeMode: "soft" },
    reason: null,
    at: "2026-10-15T09:00:00Z",
    ...over,
  });

  it("names how an admin froze it, and nothing for an act that set no mode", () => {
    expect(historyFreezeMode(entry({}))).toBe("soft");
    expect(historyFreezeMode(entry({ action: "grant_freeze_mode_set", after: { freezeMode: "hard" } }))).toBe("hard");
    expect(historyFreezeMode(entry({ action: "grant_unfreeze", after: { freezeMode: null } }))).toBeNull();
    expect(historyFreezeMode(entry({ after: { freezeMode: "bogus" } }))).toBeNull();
    expect(historyFreezeMode(entry({ after: null }))).toBeNull();
  });

  it("reads the user's own freeze as theirs, and an admin's with its mode", async () => {
    const history = vi.fn().mockResolvedValue({
      grantId: "g-1",
      page: 1,
      pageSize: 20,
      total: 2,
      rows: [entry({ id: "a-2", action: "grant_self_freeze", after: { freezeMode: "self" } }), entry({})],
    });
    render(<GrantHistory api={{ history } as unknown as ResellerUserGrantsApi} grantId="g-1" refresh={0} />);
    fireEvent.click(screen.getByRole("button", { name: H.open }));
    const list = await screen.findByRole("list");
    const [own, admin] = within(list).getAllByRole("listitem");
    expect(own.textContent).toContain(H.action.grant_self_freeze);
    expect(admin.textContent).toContain(H.action.grant_freeze);
    expect(admin.textContent).toContain(H.mode.soft);
  });
});

describe("the reseller's freeze switches", () => {
  it("are read, and saved whole", async () => {
    const api = {
      freezeSettings: vi.fn().mockResolvedValue({ selfFreezeEnabled: true, selfFreezeStopsClock: false, platformDefault: { selfFreezeEnabled: true, selfFreezeStopsClock: false } }),
      setFreezeSettings: vi.fn().mockResolvedValue({ selfFreezeEnabled: false, selfFreezeStopsClock: false, platformDefault: { selfFreezeEnabled: true, selfFreezeStopsClock: false } }),
    };
    vi.mocked(grantLimitsApi).mockReturnValue(api as unknown as ReturnType<typeof grantLimitsApi>);
    render(<FreezeSettingsCard tenantId="t-1" />);
    const enabled = (await screen.findByRole("checkbox", { name: FS.enabled })) as HTMLInputElement;
    expect(enabled.checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: FS.stopsClock }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(enabled);
    fireEvent.click(screen.getByRole("button", { name: FS.save }));
    await waitFor(() => expect(api.setFreezeSettings).toHaveBeenCalledWith({ selfFreezeEnabled: false, selfFreezeStopsClock: false }));
    expect(await screen.findByText(FS.saved)).toBeTruthy();
  });
});
