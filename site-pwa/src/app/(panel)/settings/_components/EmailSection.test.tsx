import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EmailSection } from "./EmailSection";

/**
 * Adding an email address from the panel (F-035-j), over `auth-api` v14.
 *
 * > **The code confirms the address it was mailed to, and nothing else.**
 *
 * `auth/me/email/verify` takes the address beside the code, so a panel that
 * sent whatever the field holds at confirm time would let "send to A, edit to
 * B, type A's code" reach the server as a claim on B. The server refuses it —
 * the code is bound to A — but the user then sees "wrong code" for a code that
 * was right. So the field locks once a code is out, and changing the address
 * goes back to the first step and forgets the delivery it was waiting on.
 *
 * `user.email` is only ever written by confirm (identity invariant #15), so
 * the address shown as the account's is the one `GET auth/me` answers after
 * a reload — never the one typed.
 */

const requestEmailCode = vi.fn();
const confirmEmail = vi.fn();
const reload = vi.fn();
const start = vi.fn();
const reset = vi.fn();
let me: { email: string | null } = { email: null };

vi.mock("@/context/LocaleContext", () => ({ useLocale: () => ({ t, lang: "en" }) }));
vi.mock("@/lib/auth-api", () => ({
  authApi: {
    requestEmailCode: (...a: unknown[]) => requestEmailCode(...a),
    confirmEmail: (...a: unknown[]) => confirmEmail(...a),
  },
}));
vi.mock("../../_context/PanelSessionContext", () => ({
  usePanelSession: () => ({ me, reload }),
}));
vi.mock("@auth/auth/_hooks/useOtpDelivery", () => ({
  useOtpDelivery: () => ({ delivery: { state: "queued" }, start, reset }),
}));
vi.mock("@/hooks/useApiError", () => ({ useApiErrorMessage: () => () => "error" }));

/** The key back, so an assertion names the string the component asked for. */
const t = (_ns: string, key: string) => key;

const HANDLES = { deliveryId: "d1", channel: "otp:c1", channelToken: "tok" };

function typeCode(code: string) {
  const boxes = screen.getAllByRole("textbox").filter((el) => el.getAttribute("maxlength") === "1");
  code.split("").forEach((digit, i) => fireEvent.change(boxes[i], { target: { value: digit } }));
}

describe("the email section", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    me = { email: null };
    requestEmailCode.mockResolvedValue({ accepted: true, ...HANDLES });
    confirmEmail.mockResolvedValue({ email: "a@example.com", emailVerifiedAt: "2026-09-17T00:00:00Z" });
  });

  it("confirms the address the code went to, with the delivery handles the 202 gave", async () => {
    render(<EmailSection />);
    const field = screen.getByLabelText("settings.email.address");
    fireEvent.change(field, { target: { value: " a@example.com " } });
    fireEvent.click(screen.getByRole("button", { name: "settings.email.sendCode" }));

    await waitFor(() => expect(start).toHaveBeenCalledWith(expect.objectContaining(HANDLES)));
    expect(requestEmailCode).toHaveBeenCalledWith("a@example.com");
    expect(screen.getByLabelText("settings.email.address")).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("settings.email.sending");

    typeCode("123456");
    fireEvent.click(screen.getByRole("button", { name: "settings.email.confirm" }));

    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(confirmEmail).toHaveBeenCalledWith("a@example.com", "123456");
  });

  it("forgets the code and the delivery when the address is changed", async () => {
    render(<EmailSection />);
    fireEvent.change(screen.getByLabelText("settings.email.address"), { target: { value: "a@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "settings.email.sendCode" }));
    await waitFor(() => expect(start).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "settings.email.changeAddress" }));

    expect(reset).toHaveBeenCalled();
    expect(screen.getByLabelText("settings.email.address")).not.toBeDisabled();
    expect(screen.queryByRole("button", { name: "settings.email.confirm" })).toBeNull();
    expect(confirmEmail).not.toHaveBeenCalled();
  });

  it("shows the account's address from the session, not the one typed", () => {
    me = { email: "held@example.com" };
    render(<EmailSection />);
    expect(screen.getByText("held@example.com")).toBeInTheDocument();
    expect(screen.getByText("settings.email.verified")).toBeInTheDocument();
  });
});
