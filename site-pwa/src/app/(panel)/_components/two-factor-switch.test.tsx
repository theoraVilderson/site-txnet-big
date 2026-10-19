import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { OTP_LENGTH } from "@/lib/otp";
import { TwoFactorSwitchDialog } from "./TwoFactorSwitchDialog";

const C = FrontendI18nKeys.common.accounts;

const api = vi.hoisted(() => ({
  switchByPassword: vi.fn(),
  switchByCode: vi.fn(),
  switchAccount: vi.fn(),
}));

vi.mock("@/lib/auth-api", () => ({ authApi: api }));
vi.mock("@/context/LocaleContext", () => ({
  useLocale: () => ({ lang: "en", isRtl: false, t: (_ns: string, key: string) => key }),
}));
vi.mock("@/hooks/useApiError", () => ({ useApiErrorMessage: () => (e: unknown) => String(e) }));
vi.mock("@auth/auth/_hooks/useCaptcha", () => ({
  useCaptcha: () => ({ verified: true, token: "pass", complete: vi.fn(), spend: vi.fn() }),
}));
vi.mock("@auth/auth/_components/NatureCaptchaUI", () => ({ NatureCaptchaUI: () => null }));
// SA-1-f: the deployment offers sms and telegram, and the person picks.
vi.mock("@auth/auth/_hooks/useOtpChannels", () => ({
  useOtpChannels: () => ({
    channels: [{ channel: "sms", requiresLink: false }, { channel: "telegram", requiresLink: true }],
    selected: "telegram",
    select: vi.fn(),
    hasChoice: true,
  }),
}));

const assign = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, "location", { value: { assign }, writable: true });
  api.switchByPassword.mockResolvedValue({ requiresOtp: true, otpToken: "tok", resendIn: 60 });
  api.switchByCode.mockResolvedValue({ accessToken: "at" });
});

// ADR-0145: a holder of `*` is reached from the switcher by password and then a
// code — never by the one-click switch, which the server refuses them.
describe("TwoFactorSwitchDialog", () => {
  const member = { userId: "u-star", fullName: "Theora", phoneMasked: "+989***3603", needsBothFactors: true };

  it("asks the member's password, then the code, then lands on the panel as them", async () => {
    render(<TwoFactorSwitchDialog member={member} onClose={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText(C.passwordPlaceholder), { target: { value: "s3cret" } });
    fireEvent.click(screen.getByRole("button", { name: C.sendCode }));
    await waitFor(() => expect(api.switchByPassword).toHaveBeenCalledWith("u-star", "s3cret", "pass", "telegram"));

    // The login screen's digit boxes (2026-10-19: this was one plain field),
    // and a full code submits itself as it does there.
    const boxes = await screen.findAllByRole("textbox");
    expect(boxes).toHaveLength(OTP_LENGTH);
    fireEvent.paste(boxes[0], { clipboardData: { getData: () => "123456" } });

    await waitFor(() => expect(api.switchByCode).toHaveBeenCalledWith("tok", "123456"));
    expect(api.switchByCode).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("/");
    expect(api.switchAccount).not.toHaveBeenCalled();
  });

  it("stays on the password step with the server's sentence when it refuses", async () => {
    api.switchByPassword.mockRejectedValueOnce("wrong password");
    render(<TwoFactorSwitchDialog member={member} onClose={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText(C.passwordPlaceholder), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: C.sendCode }));

    expect(await screen.findByText("wrong password")).toBeTruthy();
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
  });

  it("hands over the bot link for a messenger not yet connected, and still takes the code (SA-1-f)", async () => {
    api.switchByPassword.mockResolvedValueOnce({ accepted: true, linkRequired: true, deepLink: "https://t.me/bot?start=x", otpToken: "tok" });
    render(<TwoFactorSwitchDialog member={member} onClose={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText(C.passwordPlaceholder), { target: { value: "s3cret" } });
    fireEvent.click(screen.getByRole("button", { name: C.sendCode }));

    expect((await screen.findByRole("link", { name: C.twoFactor.openBot })).getAttribute("href")).toBe("https://t.me/bot?start=x");
    fireEvent.click(screen.getByRole("button", { name: C.twoFactor.sendAgain }));
    expect(await screen.findByPlaceholderText(C.passwordPlaceholder)).toBeTruthy();
  });

  // 2026-10-19: "send again" was offered at once, so a second code inside the
  // server's cooldown was refused after the password and slide were spent.
  it("offers send-again only once the server's wait is over", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<TwoFactorSwitchDialog member={member} onClose={vi.fn()} />);
      fireEvent.change(screen.getByPlaceholderText(C.passwordPlaceholder), { target: { value: "s3cret" } });
      fireEvent.click(screen.getByRole("button", { name: C.sendCode }));

      expect(await screen.findByText(C.resendCodeIn, { exact: false })).toBeTruthy();
      expect(screen.queryByRole("button", { name: C.twoFactor.sendAgain })).toBeNull();

      // One tick per render: the timer re-arms after each second it counts.
      for (let i = 0; i < 61; i++) await act(async () => { vi.advanceTimersByTime(1_000); });
      expect(await screen.findByRole("button", { name: C.twoFactor.sendAgain })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
