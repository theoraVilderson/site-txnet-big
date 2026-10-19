import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { ApiError } from "@/lib/api-error";
import AddAccountPage from "./page";

/**
 * 2026-10-08, adding a second account from the switcher:
 *  - a pasted code sat in the boxes waiting for Confirm, where the login
 *    screen submits it — the boxes were not inside a form, so `OTPInput`'s
 *    `requestSubmit` had nothing to submit;
 *  - once added, the panel stayed on the account that was already open. The
 *    add answers the new member's `userId`, so the page switches to it and
 *    loads the panel as that account.
 */

const A = FrontendI18nKeys.common.accounts;

const api = vi.hoisted(() => ({
  addAccountOtpRequest: vi.fn(),
  addAccountOtpVerify: vi.fn(),
  addAccountPassword: vi.fn(),
  switchAccount: vi.fn(),
  botLinkStatus: vi.fn(),
}));
const assign = vi.fn();

vi.mock("@/lib/auth-api", () => ({ authApi: api }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/context/LocaleContext", () => ({
  useLocale: () => ({ lang: "en", isRtl: false, t: (_ns: string, key: string) => key }),
}));
vi.mock("../../_context/PanelSessionContext", () => ({ usePanelSession: () => ({ reload: vi.fn() }) }));
vi.mock("@/hooks/useApiError", () => ({ useApiErrorMessage: () => (e: unknown) => String(e) }));
vi.mock("@auth/auth/_hooks/useCaptcha", () => ({
  useCaptcha: () => ({ verified: true, token: "pass", complete: vi.fn(), spend: vi.fn() }),
}));
vi.mock("@auth/auth/_hooks/useOtpChannels", () => ({
  useOtpChannels: () => ({ channels: [], hasChoice: false, selected: undefined, select: vi.fn() }),
}));
vi.mock("@auth/auth/_components/NatureCaptchaUI", () => ({ NatureCaptchaUI: () => null }));
vi.mock("@auth/auth/_components/PhoneField", () => ({
  PhoneField: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <input aria-label="phone" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, assign } });
  api.addAccountOtpRequest.mockResolvedValue({ accepted: true, resendIn: 60 });
  api.addAccountOtpVerify.mockResolvedValue({ groupId: "g-1", added: true, userId: "u-2" });
  api.addAccountPassword.mockResolvedValue({ groupId: "g-1", added: true, userId: "u-2" });
  api.switchAccount.mockResolvedValue({ userId: "u-2" });
});

async function toCodeStep() {
  render(<AddAccountPage />);
  fireEvent.change(screen.getByLabelText("phone"), { target: { value: "+989121234567" } });
  fireEvent.click(screen.getByRole("button", { name: A.sendCode }));
  await waitFor(() => expect(screen.getAllByRole("textbox").length).toBeGreaterThan(1));
}

describe("adding an account", () => {
  it("a pasted code is verified without pressing Confirm", async () => {
    await toCodeStep();
    const firstBox = screen.getAllByRole("textbox")[1];
    fireEvent.paste(firstBox, { clipboardData: { getData: () => "123456" } });
    await waitFor(() => expect(api.addAccountOtpVerify).toHaveBeenCalledWith("+989121234567", "123456"));
    expect(api.addAccountOtpVerify).toHaveBeenCalledTimes(1);
  });

  it("switches to the account just added and loads the panel as it", async () => {
    await toCodeStep();
    fireEvent.paste(screen.getAllByRole("textbox")[1], { clipboardData: { getData: () => "123456" } });
    await waitFor(() => expect(api.switchAccount).toHaveBeenCalledWith("u-2"));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
  });

  it("the password proof switches too", async () => {
    render(<AddAccountPage />);
    // The chosen proof is said, not only coloured (2026-10-19: the tabs changed text colour alone).
    const tab = screen.getByRole("radio", { name: A.proof.password });
    fireEvent.click(tab);
    expect(tab.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: A.proof.otp }).getAttribute("aria-checked")).toBe("false");
    fireEvent.change(screen.getByPlaceholderText(A.identifierPlaceholder), { target: { value: "sara" } });
    fireEvent.change(screen.getByPlaceholderText(A.passwordPlaceholder), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: A.confirm }));
    await waitFor(() => expect(api.switchAccount).toHaveBeenCalledWith("u-2"));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
  });

  // 2026-10-19: a code sent to the number from another screen a moment ago
  // refuses this one; the server says how long, and the screen counts it.
  it("a cooldown refusal says the seconds left and counts them down", async () => {
    api.addAccountOtpRequest.mockRejectedValueOnce(new ApiError("wait", { status: 429, reason: "otpCooldown", facts: { retryAfter: 42 } }));
    render(<AddAccountPage />);
    fireEvent.change(screen.getByLabelText("phone"), { target: { value: "+989121234567" } });
    fireEvent.click(screen.getByRole("button", { name: A.sendCode }));

    expect(await screen.findByText("0:42")).toBeTruthy();
    expect((screen.getByRole("button", { name: A.sendCode }) as HTMLButtonElement).disabled).toBe(true);
  });
});
