import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { ApiError } from "@/lib/api-error";
import { useResend } from "./useResend";

/**
 * F-0201-f: "Resend code" used to restart the timer and send nothing. It now
 * sends — the step's own send again — and only then restarts the timer and
 * the delivery status; a refusal is shown, and the timer is left at zero so
 * the button stays offered.
 */
describe("useResend", () => {
  const parts = () => ({
    delivery: { start: vi.fn() },
    otpTimer: { startFrom: vi.fn(), holdFor: vi.fn(() => false) },
    submitError: { clear: vi.fn(), capture: vi.fn() },
  });
  const handles = { deliveryId: "d", channel: "otp:c", channelToken: "t", resendIn: 60 };

  it("sends, then restarts the delivery status and the timer", async () => {
    const p = parts();
    const { result } = renderHook(() => useResend(p));
    const send = vi.fn(async () => handles);
    await act(() => result.current(send));
    expect(send).toHaveBeenCalledOnce();
    expect(p.delivery.start).toHaveBeenCalledWith(handles);
    // The server's own wait, never a figure of this screen's (2026-10-19).
    expect(p.otpTimer.startFrom).toHaveBeenCalledWith(handles);
  });

  it("shows a refusal and leaves the timer alone", async () => {
    const p = parts();
    const { result } = renderHook(() => useResend(p));
    const refusal = new Error("otp.resendExpired");
    await act(() => result.current(async () => Promise.reject(refusal)));
    expect(p.submitError.capture).toHaveBeenCalledWith(refusal);
    expect(p.otpTimer.startFrom).not.toHaveBeenCalled();
  });

  it("offers a cooldown refusal to the timer, so it counts the seconds the server named", async () => {
    const p = parts();
    const { result } = renderHook(() => useResend(p));
    const refusal = new ApiError("wait", { status: 429, reason: "otpCooldown", facts: { retryAfter: 42 } });
    await act(() => result.current(async () => Promise.reject(refusal)));
    expect(p.otpTimer.holdFor).toHaveBeenCalledWith(refusal);
    expect(p.submitError.capture).toHaveBeenCalledWith(refusal);
  });
});
