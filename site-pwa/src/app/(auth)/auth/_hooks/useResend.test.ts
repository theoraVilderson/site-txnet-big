import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
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
    otpTimer: { start: vi.fn() },
    submitError: { clear: vi.fn(), capture: vi.fn() },
  });
  const handles = { deliveryId: "d", channel: "otp:c", channelToken: "t" };

  it("sends, then restarts the delivery status and the timer", async () => {
    const p = parts();
    const { result } = renderHook(() => useResend(p));
    const send = vi.fn(async () => handles);
    await act(() => result.current(send));
    expect(send).toHaveBeenCalledOnce();
    expect(p.delivery.start).toHaveBeenCalledWith(handles);
    expect(p.otpTimer.start).toHaveBeenCalledWith(120);
  });

  it("shows a refusal and leaves the timer alone", async () => {
    const p = parts();
    const { result } = renderHook(() => useResend(p));
    const refusal = new Error("otp.resendExpired");
    await act(() => result.current(async () => Promise.reject(refusal)));
    expect(p.submitError.capture).toHaveBeenCalledWith(refusal);
    expect(p.otpTimer.start).not.toHaveBeenCalled();
  });
});
