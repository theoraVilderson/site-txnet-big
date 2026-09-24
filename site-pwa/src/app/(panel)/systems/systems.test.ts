import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PANEL_MENU, isMenuGroup } from "../_lib/panel-menu";
import { PANEL_SYSTEMS } from "@/lib/routes";
import type { SystemsDriftEvent, SystemsHold, SystemsPanel } from "@/lib/billing-api";
import {
  CAPABILITY_KEYS,
  COUNTER_SEMANTICS,
  DRIFT_EVENT_KEYS,
  DRIVER_LABELS,
  DRIVER_TYPES,
  driverLabel,
  FAULT_KEYS,
  HOLD_REASON_KEYS,
  HOLD_STATE_KEYS,
  PANEL_MANAGE,
  PANEL_ROLES,
  PANEL_STATE_KEYS,
  PANEL_TRANSPORTS,
  REFUSAL_KEYS,
  REVIEW_KEYS,
  SYSTEMS_KEYS,
  canAcknowledge,
  canResubmit,
  canResubmitRadiusSecret,
  canResolveHold,
  emptyRegisterForm,
  haltsCollection,
  radiusSecretMissing,
  refusedBecause,
  resubmitOutcome,
  validateNote,
  validateLogin,
  validateRadiusSecret,
  validateRegister,
  verdictOf,
} from "./_lib/systems";

/**
 * The systems page (F-027-ad, ADR-0080). What breaks silently:
 *  - a capability row, a fault, a hold reason or a panel state the backend can
 *    write with no sentence here — a blank cell exactly where the page is
 *    supposed to say why a panel was refused, or why bytes were not billed.
 *    Each set is read out of its declared home, not retyped;
 *  - a register form that sends what billing refuses, or omits what a pull
 *    panel needs;
 *  - a panel reading as refused or accepted before the connection test ran —
 *    the verdict is `pending` until the next tick, and a fault is not a verdict;
 *  - release / write-off / acknowledge offered on something already decided;
 *  - the menu showing the page to anyone but the platform owner's `panel.manage`.
 */
const REPO = join(__dirname, "../../../../..");
const PRISMA = readFileSync(join(REPO, "txnet-backend/prisma/domains/network.prisma"), "utf8");
const SYSTEMS = join(REPO, "txnet-backend/billing-service/src/app/systems");
const LOCALES = join(REPO, "locales/frontend/langs");

function prismaEnum(name: string): string[] {
  const block = new RegExp(`enum ${name} \\{([\\s\\S]*?)\\}`).exec(PRISMA);
  if (!block) throw new Error(`enum ${name} is gone from network.prisma — this test is stale`);
  return block[1]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[a-z_]+$/.test(l));
}

describe("every value the backend can write has a sentence here", () => {
  it.each<[string, readonly string[]]>([
    ["PanelReviewState", Object.keys(REVIEW_KEYS)],
    ["PanelState", Object.keys(PANEL_STATE_KEYS)],
    ["ConnectionTestFault", Object.keys(FAULT_KEYS)],
    ["HoldReason", Object.keys(HOLD_REASON_KEYS)],
    ["UsageDispositionState", Object.keys(HOLD_STATE_KEYS)],
    ["PanelDriftEventType", Object.keys(DRIFT_EVENT_KEYS)],
    ["DriverType", DRIVER_TYPES],
    ["CounterSemantics", COUNTER_SEMANTICS],
    ["PanelTransport", PANEL_TRANSPORTS],
    ["PanelRole", PANEL_ROLES],
  ])("%s", (name, here) => {
    expect([...here].sort()).toEqual(prismaEnum(name).sort());
  });

  it("the questionnaire, in its order, from contracts/network/capabilities.json", () => {
    const fixture = JSON.parse(readFileSync(join(REPO, "contracts/network/capabilities.json"), "utf8")) as {
      rows: { key: string }[];
    };
    expect(Object.keys(CAPABILITY_KEYS)).toEqual(fixture.rows.map((r) => r.key));
  });

  it("every refusal billing's systems routes name", () => {
    const union = (file: string, type: string) => {
      const m = new RegExp(`export type ${type} =([^;]*);`).exec(readFileSync(join(SYSTEMS, file), "utf8"));
      if (!m) throw new Error(`${type} is no longer a literal union — this test is stale`);
      return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    };
    const billing = [
      ...union("systems-read.ts", "SystemsRejection"),
      ...union("panel-scope.ts", "PanelScopeRejection"),
      ...union("panel-registration.ts", "ResubmitRejection"),
      "credentials_unavailable",
    ];
    expect(Object.keys(REFUSAL_KEYS).sort()).toEqual(billing.sort());
  });
});

describe("a family is shown by its product name", () => {
  it("tells 3x-ui v2 (sanaee) from v3 (three_x_ui), whose APIs differ (F-027-bb)", () => {
    expect(new Set(Object.values(DRIVER_LABELS)).size).toBe(DRIVER_TYPES.length);
    expect(DRIVER_LABELS.sanaee).toContain("v2");
    expect(DRIVER_LABELS.three_x_ui).toContain("v3");
    expect(DRIVER_LABELS.x_ui_alireza).toContain("alireza0");
    expect(DRIVER_LABELS.x_ui_vaxilu).toContain("vaxilu");
    expect(driverLabel("not_a_family")).toBe("not_a_family");
  });
});

describe("validateRegister mirrors registerPanelSchema", () => {
  const good = {
    ...emptyRegisterForm(),
    name: " de-1 ",
    ipAddress: "203.0.113.7",
    apiBaseUrl: "https://de-1.example.net:2053",
    region: " de ",
    credentials: " admin:secret ",
  };

  it("sends a pull panel trimmed, the login untouched, and no budget when left blank", () => {
    const out = validateRegister(good);
    expect(out).toEqual({
      ok: true,
      body: {
        name: "de-1",
        ipAddress: "203.0.113.7",
        apiBaseUrl: "https://de-1.example.net:2053",
        driverType: "marzban",
        counterSemantics: "cumulative",
        transport: "pull",
        role: "active",
        region: "de",
        credentials: " admin:secret ",
      },
    });
  });

  it("needs an address to poll for a pull panel, and sends none for a push one left blank", () => {
    const pull = validateRegister({ ...good, apiBaseUrl: " " });
    expect(pull.ok ? null : pull.errors.apiBaseUrl).toBe(SYSTEMS_KEYS.register.invalid.apiBaseUrl);
    const push = validateRegister({ ...good, transport: "push", apiBaseUrl: "" });
    expect(push.ok && "apiBaseUrl" in push.body).toBe(false);
  });

  it.each([
    ["ipAddress", { ipAddress: "300.1.1.1" }],
    ["ipAddress", { ipAddress: "example.net" }],
    ["name", { name: "  " }],
    ["name", { name: "x".repeat(101) }],
    ["region", { region: "x".repeat(51) }],
    ["apiBaseUrl", { apiBaseUrl: "not a url" }],
    ["maxRequestsPerMinute", { maxRequestsPerMinute: "0" }],
    ["maxRequestsPerMinute", { maxRequestsPerMinute: "6001" }],
    ["maxRequestsPerMinute", { maxRequestsPerMinute: "1.5" }],
    ["credentials", { credentials: "" }],
    ["credentials", { credentials: "x".repeat(4097) }],
  ])("refuses %s in %j", (field, override) => {
    const out = validateRegister({ ...good, ...override });
    expect(out.ok ? [] : Object.keys(out.errors)).toContain(field);
  });

  // F-027-az: a push panel's NAS signs accounting with a secret of its own.
  it("needs a RADIUS secret on a push panel, sends it as typed, and never sends one for a pull panel", () => {
    const push = { ...good, transport: "push" as const, apiBaseUrl: "https://10.0.0.1" };
    const missing = validateRegister(push);
    expect(missing.ok ? null : missing.errors.radiusSecret).toBe(SYSTEMS_KEYS.register.invalid.radiusSecret);
    const sent = validateRegister({ ...push, radiusSecret: " nas secret " });
    expect(sent.ok && sent.body.radiusSecret).toBe(" nas secret ");
    const pull = validateRegister({ ...good, radiusSecret: "typed, then switched to pull" });
    expect(pull.ok && "radiusSecret" in pull.body).toBe(false);
  });

  it("accepts an IPv6 address and a budget inside 1–6000", () => {
    const out = validateRegister({ ...good, ipAddress: "2001:db8::7", maxRequestsPerMinute: "120" });
    expect(out.ok && out.body.ipAddress).toBe("2001:db8::7");
    expect(out.ok && out.body.maxRequestsPerMinute).toBe(120);
  });
});

const panel = (review: Partial<SystemsPanel["review"]>): SystemsPanel => ({
  id: "11111111-1111-4111-8111-111111111111",
  name: "de-1",
  driverType: "marzban",
  transport: "pull",
  role: "active",
  region: "de",
  review: { reviewState: "pending", connectionTestedAt: null, connectionTestFault: null, connectionTestDetail: null, ...review },
  health: { panelState: "healthy", lastHealthyAt: null, lastSuccessfulCollectionAt: null, collectionHalted: false, openDriftEvents: 0 },
  budget: { maxRequestsPerMinute: 60, blockedSince: null },
  radiusSecretConfigured: null,
});

describe("verdictOf — the connection test's answer, never one made up here", () => {
  it("is pending until the next tick, and a fault leaves it pending", () => {
    expect(verdictOf(panel({}))).toEqual({ state: "pending", fault: null });
    expect(verdictOf(panel({ connectionTestFault: "timeout", connectionTestedAt: "2026-09-24T10:00:00Z" }))).toEqual({
      state: "pending",
      fault: "timeout",
    });
  });

  it("carries a refusal and the accepted states as the loop wrote them", () => {
    expect(verdictOf(panel({ reviewState: "refused", connectionTestedAt: "2026-09-24T10:00:00Z" })).state).toBe("refused");
    expect(verdictOf(panel({ reviewState: "accepted_low_trust" })).state).toBe("accepted_low_trust");
  });
});

describe("refusedBecause — the rows that refused a panel at registration", () => {
  const row = (key: string, severity: string, state: string) => ({ key, scope: "any", severity, state, detail: null });

  it("names the unmet required rows, and the metered ones apart", () => {
    const out = refusedBecause([
      row("per_client_usage", "required", "unsupported"),
      row("enable_disable_client", "required", "supported"),
      row("per_client_data_limit", "metered", "unsupported"),
      row("usage_reset_supported", "degrades", "unsupported"),
      row("bulk_usage_in_one_call", "required", "not_asked"),
      row("client_lifecycle", "required", "unanswered"),
    ]);
    expect(out).toEqual({ refused: ["per_client_usage"], noMeteredSale: ["per_client_data_limit"] });
  });
});

// F-027-av: a new login for a registered panel (billing F-027-au).
describe("re-submitting a panel's login", () => {
  it("is offered on every panel but a refused one", () => {
    expect(canResubmit(panel({}))).toBe(true);
    expect(canResubmit(panel({ reviewState: "accepted" }))).toBe(true);
    expect(canResubmit(panel({ reviewState: "refused" }))).toBe(false);
  });

  it("sends the login as typed, within 1–4096", () => {
    expect(validateLogin(" pw ")).toEqual({ ok: true, credentials: " pw " });
    expect(validateLogin("")).toEqual({ ok: false, error: SYSTEMS_KEYS.register.invalid.credentials });
    expect(validateLogin("x".repeat(4097))).toEqual({ ok: false, error: SYSTEMS_KEYS.register.invalid.credentials });
  });

  it("says what the answer means: re-tested, cooling off, or rotated under a live panel", () => {
    const answer = (reviewState: SystemsPanel["review"]["reviewState"], retest: boolean) => ({
      id: "p",
      reviewState,
      retest,
      credentials: { configured: true, version: 2, rotatedAt: null },
    });
    expect(resubmitOutcome(answer("pending", true))).toBe(SYSTEMS_KEYS.resubmit.outcome.retest);
    expect(resubmitOutcome(answer("pending", false))).toBe(SYSTEMS_KEYS.resubmit.outcome.coolingOff);
    expect(resubmitOutcome(answer("accepted", false))).toBe(SYSTEMS_KEYS.resubmit.outcome.rotated);
    expect(resubmitOutcome(answer("accepted_low_trust", false))).toBe(SYSTEMS_KEYS.resubmit.outcome.rotated);
  });
});

// F-027-az: a push panel's RADIUS secret, kept apart from its login.
describe("a push panel's RADIUS secret", () => {
  const push = (over: Partial<SystemsPanel>): SystemsPanel => ({ ...panel({}), transport: "push", radiusSecretConfigured: true, ...over });

  it("is offered on a push panel that is not refused, and never on a pull panel", () => {
    expect(canResubmitRadiusSecret(push({}))).toBe(true);
    expect(canResubmitRadiusSecret(push({ review: { ...panel({}).review, reviewState: "refused" } }))).toBe(false);
    expect(canResubmitRadiusSecret(panel({}))).toBe(false);
  });

  it("says when a push panel has none, which keeps its NAS off the allowlist", () => {
    expect(radiusSecretMissing(push({ radiusSecretConfigured: false }))).toBe(true);
    expect(radiusSecretMissing(push({}))).toBe(false);
    expect(radiusSecretMissing(panel({}))).toBe(false);
  });

  it("is sent as typed, within 1–4096", () => {
    expect(validateRadiusSecret(" s ")).toEqual({ ok: true, radiusSecret: " s " });
    expect(validateRadiusSecret("")).toEqual({ ok: false, error: SYSTEMS_KEYS.register.invalid.radiusSecret });
  });
});

const hold = (state: SystemsHold["state"]): SystemsHold => ({
  id: "22222222-2222-4222-8222-222222222222",
  configId: "33333333-3333-4333-8333-333333333333",
  panelId: "11111111-1111-4111-8111-111111111111",
  panelName: "de-1",
  upBytes: "9007199254740993",
  downBytes: "0",
  reason: "gigawords_missing",
  state,
  heldFrom: "2026-09-24T09:00:00Z",
  heldAt: "2026-09-24T09:05:00Z",
  resolvedAt: null,
  resolvedByAdminId: null,
  resolutionNote: null,
});

describe("the holds queue", () => {
  it("offers release and write-off only on a pending hold", () => {
    expect(canResolveHold(hold("pending"))).toBe(true);
    expect(canResolveHold(hold("released"))).toBe(false);
    expect(canResolveHold(hold("written_off"))).toBe(false);
  });

  it("requires a note to write off, not to release; both within 1–1000, trimmed", () => {
    expect(validateNote("  ", { required: true })).toEqual({ ok: false, error: SYSTEMS_KEYS.note.required });
    expect(validateNote("  ", { required: false })).toEqual({ ok: true, note: undefined });
    expect(validateNote(" restored ", { required: true })).toEqual({ ok: true, note: "restored" });
    expect(validateNote("x".repeat(1001), { required: false })).toEqual({ ok: false, error: SYSTEMS_KEYS.note.tooLong });
  });
});

const drift = (overrides: Partial<SystemsDriftEvent>): SystemsDriftEvent => ({
  id: "44444444-4444-4444-8444-444444444444",
  panelId: "11111111-1111-4111-8111-111111111111",
  panelName: "de-1",
  eventType: "mass_reset",
  affectedConfigCount: 40,
  observedConfigCount: 50,
  detectedAt: "2026-09-24T09:00:00Z",
  collectionHalted: true,
  acknowledgedAt: null,
  acknowledgedByAdminId: null,
  note: null,
  ...overrides,
});

describe("the drift report", () => {
  it("halts collection exactly when the collector says so: halted and unacknowledged", () => {
    expect(haltsCollection(drift({}))).toBe(true);
    expect(haltsCollection(drift({ acknowledgedAt: "2026-09-24T10:00:00Z" }))).toBe(false);
    expect(haltsCollection(drift({ collectionHalted: false }))).toBe(false);
  });

  it("offers acknowledge once", () => {
    expect(canAcknowledge(drift({}))).toBe(true);
    expect(canAcknowledge(drift({ acknowledgedAt: "2026-09-24T10:00:00Z" }))).toBe(false);
  });
});

describe("the menu", () => {
  it("shows the page to the platform owner's panel.manage and nobody else", () => {
    const links = PANEL_MENU.flatMap((e) => (isMenuGroup(e) ? e.children : [e]));
    const entry = links.find((l) => l.href === PANEL_SYSTEMS);
    expect(entry?.requires).toEqual([PANEL_MANAGE]);
    expect(entry?.tenantTypes).toEqual(["platform_owner"]);
  });
});

describe("every key this page can reach", () => {
  const flatten = (v: unknown): string[] =>
    typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(flatten) : [];
  const shipped = (lang: string) => {
    const out = new Set<string>();
    const walk = (prefix: string, value: unknown) => {
      if (value && typeof value === "object") for (const [k, c] of Object.entries(value)) walk(prefix ? `${prefix}.${k}` : k, c);
      else if (typeof value === "string") out.add(prefix);
    };
    walk("", JSON.parse(readFileSync(join(LOCALES, lang, "common.json"), "utf8")));
    return out;
  };

  it.each(["en", "fa"])("resolves in %s", (lang) => {
    const keys = shipped(lang);
    expect(flatten(SYSTEMS_KEYS).filter((k) => !keys.has(k))).toEqual([]);
  });
});
