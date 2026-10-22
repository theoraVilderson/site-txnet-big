/**
 * The reseller's self-move setting (F-410-f, over billing F-410-a;
 * `panel-web/contract.self-move.md` "The reseller's setting"):
 *
 *  - **each value is inherited or its own**, said outright: null on the wire
 *    is "as the layer above", and `false` / `0` are values of their own;
 *  - **the inherited value is billing's**, named with the layer it came from
 *    — the platform's for the tenant's layer, the tenant's in effect for a
 *    product — never computed here;
 *  - **a save sends both values**, as billing's schema requires, on the
 *    tenant's route or the product's, and shows the view billing answered.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { selfMoveSettingsApi, type SelfMoveSettingsView } from "@/lib/billing-api";
import { SelfMoveSettings } from "./SelfMoveSettings";
import { inheritedOf, ownOf, selfMoveBodyOf, selfMoveChoiceOf, setsSelfMove } from "../_lib/self-move-settings";

vi.mock("@/context/LocaleContext", () => ({ useLocale: () => ({ t, lang: "en" }) }));
vi.mock("@/lib/billing-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing-api")>()),
  selfMoveSettingsApi: vi.fn(),
}));

const K = FrontendI18nKeys.common.selfMoveSettings;
/** The key back, with its values, so an assertion names what the component asked for. */
const t = (_ns: string, key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key);

const VIEW: SelfMoveSettingsView = {
  platformDefault: { enabled: true, cooldownHours: 24 },
  tenant: { enabled: false, cooldownHours: null },
  effective: { enabled: { value: false, layer: "tenant" }, cooldownHours: { value: 24, layer: "platform" } },
  products: [
    {
      productId: "p-1",
      enabled: true,
      cooldownHours: 0,
      effective: { enabled: { value: true, layer: "product" }, cooldownHours: { value: 0, layer: "product" } },
    },
  ],
};

describe("the choice and the body (pure)", () => {
  it("reads null as inherited and false / 0 as values", () => {
    expect(selfMoveChoiceOf({ enabled: null, cooldownHours: null })).toEqual({ enabled: "inherit", cooldownMode: "inherit", cooldown: "" });
    expect(selfMoveChoiceOf({ enabled: false, cooldownHours: 0 })).toEqual({ enabled: "off", cooldownMode: "own", cooldown: "0" });
  });

  it("sends both values, null for inherited, whatever the hours box still holds", () => {
    const own = { enabled: true, cooldownHours: 12 };
    expect(selfMoveBodyOf({ enabled: "inherit", cooldownMode: "inherit", cooldown: "12" }, own)).toEqual({ ok: true, body: { enabled: null, cooldownHours: null } });
    expect(selfMoveBodyOf({ enabled: "off", cooldownMode: "own", cooldown: " 48 " }, own)).toEqual({ ok: true, body: { enabled: false, cooldownHours: 48 } });
  });

  it("refuses hours billing would refuse, and a save that changes nothing", () => {
    const own = { enabled: null, cooldownHours: null };
    for (const typed of ["", "1.5", "-1", "8761", "abc"]) {
      expect(selfMoveBodyOf({ enabled: "on", cooldownMode: "own", cooldown: typed }, own)).toEqual({ ok: false, error: K.invalidHours });
    }
    expect(selfMoveBodyOf({ enabled: "inherit", cooldownMode: "inherit", cooldown: "" }, own)).toEqual({ ok: false, error: K.unchanged });
  });

  it("inherits the platform's for the tenant and the tenant's in effect for a product", () => {
    expect(inheritedOf(VIEW, null)).toEqual({ enabled: { value: true, layer: "platform" }, cooldownHours: { value: 24, layer: "platform" } });
    expect(inheritedOf(VIEW, "p-1")).toEqual(VIEW.effective);
    expect(ownOf(VIEW, "p-1")).toEqual({ enabled: true, cooldownHours: 0 });
    expect(ownOf(VIEW, "p-2")).toEqual({ enabled: null, cooldownHours: null });
    expect(ownOf(VIEW, null)).toEqual(VIEW.tenant);
  });

  it("sets a product only of the tenant itself or of the platform", () => {
    expect(setsSelfMove({ tenantId: "t-1", platform: false }, "t-1")).toBe(true);
    expect(setsSelfMove({ tenantId: "t-plat", platform: true }, "t-1")).toBe(true);
    expect(setsSelfMove({ tenantId: "t-2", platform: false }, "t-1")).toBe(false);
  });
});

describe("<SelfMoveSettings>", () => {
  const api = { read: vi.fn(), setTenant: vi.fn(), setProduct: vi.fn() };
  beforeEach(() => {
    vi.clearAllMocks();
    api.read.mockResolvedValue(VIEW);
    vi.mocked(selfMoveSettingsApi).mockReturnValue(api);
  });

  it("the tenant's layer: names the platform's default, sends both values, shows what billing kept", async () => {
    api.setTenant.mockResolvedValue({ ...VIEW, tenant: { enabled: false, cooldownHours: 0 } });
    render(<SelfMoveSettings tenantId="t-1" productId={null} errorMessage={() => "refused"} />);
    expect(await screen.findByRole("radio", { name: `${K.inherit} ${JSON.stringify({ layer: K.layer.platform, value: K.on })}` })).toBeTruthy();
    expect((screen.getByRole("radio", { name: K.off }) as HTMLElement).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(`${K.overrides} ${JSON.stringify({ count: 1 })}`)).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: K.ownHours }));
    fireEvent.change(screen.getByRole("textbox", { name: K.hoursLabel }), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: K.save }));
    await waitFor(() => expect(api.setTenant).toHaveBeenCalledWith({ enabled: false, cooldownHours: 0 }));
    expect(api.setProduct).not.toHaveBeenCalled();
    expect(await screen.findByText(K.saved)).toBeTruthy();
  });

  it("a product's override: inherits the tenant's in effect, saves on the product's route, a refusal stays", async () => {
    api.setProduct.mockRejectedValue(new Error("no"));
    render(<SelfMoveSettings tenantId="t-1" productId="p-2" errorMessage={() => "refused"} />);
    expect(await screen.findByRole("radio", { name: `${K.inherit} ${JSON.stringify({ layer: K.layer.tenant, value: K.off })}` })).toBeTruthy();
    expect(screen.queryByText(`${K.overrides} ${JSON.stringify({ count: 1 })}`)).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: K.on }));
    fireEvent.click(screen.getByRole("button", { name: K.save }));
    await waitFor(() => expect(api.setProduct).toHaveBeenCalledWith("p-2", { enabled: true, cooldownHours: null }));
    expect(await screen.findByText("refused")).toBeTruthy();
    expect(screen.queryByText(K.saved)).toBeNull();
  });

  it("a save that changes nothing is named, and nothing is sent", async () => {
    render(<SelfMoveSettings tenantId="t-1" productId="p-2" errorMessage={() => "refused"} />);
    fireEvent.click(await screen.findByRole("button", { name: K.save }));
    expect(await screen.findByText(K.unchanged)).toBeTruthy();
    expect(api.setProduct).not.toHaveBeenCalled();
  });
});
