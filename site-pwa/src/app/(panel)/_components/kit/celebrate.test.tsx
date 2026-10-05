/**
 * Celebrations and haptics (UX-1-z, contract.ux.md M5–M6).
 *
 * What breaks without anyone seeing it:
 *  - **confetti under reduced motion** (M3 forbids it) or a canvas that is
 *    never taken down and sits over the page;
 *  - **a celebration twice** on one occasion — a re-render, a re-read;
 *  - **haptics outside Telegram**: a missing global must be nothing, never a
 *    throw, and an ordinary browser must not be asked to vibrate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Button } from "./Button";
import { CONFETTI, celebrate, confettiParticles, useCelebration } from "./celebrate";
import { notify } from "./notify";

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));

type Feedback = { impactOccurred: ReturnType<typeof vi.fn>; notificationOccurred: ReturnType<typeof vi.fn> };
const telegram = (): Feedback => {
  const feedback = { impactOccurred: vi.fn(), notificationOccurred: vi.fn() };
  (window as unknown as { Telegram?: unknown }).Telegram = { WebApp: { HapticFeedback: feedback } };
  return feedback;
};
const canvases = () => document.querySelectorAll("canvas[data-confetti]");

beforeEach(() => {
  vi.useFakeTimers();
  document.documentElement.removeAttribute("data-motion");
});
afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  delete (window as unknown as { Telegram?: unknown }).Telegram;
});

describe("confetti (M5)", () => {
  it("at most 120 particles over 1.6s, then the canvas is gone", () => {
    expect(CONFETTI.particles).toBeLessThanOrEqual(120);
    expect(CONFETTI.ms).toBe(1600);
    expect(confettiParticles(CONFETTI.particles, 400, 800, ["#0a0"])).toHaveLength(CONFETTI.particles);

    celebrate();
    expect(canvases()).toHaveLength(1);
    expect(canvases()[0]).toHaveAttribute("aria-hidden", "true");
    vi.advanceTimersByTime(CONFETTI.ms + 50);
    expect(canvases()).toHaveLength(0);
  });

  it("draws nothing under reduced motion, and still says it with a haptic", () => {
    const feedback = telegram();
    document.documentElement.setAttribute("data-motion", "reduced");
    celebrate();
    expect(canvases()).toHaveLength(0);
    expect(feedback.notificationOccurred).toHaveBeenCalledWith("success");
  });

  it("once per occasion per view, however often the view renders", () => {
    function View({ won, n }: { won: boolean; n: number }) {
      useCelebration(won);
      return <p>{n}</p>;
    }
    const { rerender } = render(<View won={false} n={0} />);
    expect(canvases()).toHaveLength(0);
    rerender(<View won n={1} />);
    rerender(<View won n={2} />);
    expect(canvases()).toHaveLength(1);
  });
});

describe("haptics (M6)", () => {
  it("a primary button taps lightly; another variant does not", () => {
    const feedback = telegram();
    const onClick = vi.fn();
    render(
      <>
        <Button variant="primary" onClick={onClick}>
          Pay
        </Button>
        <Button>Back</Button>
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Pay" }));
    expect(feedback.impactOccurred).toHaveBeenCalledWith("light");
    expect(onClick).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(feedback.impactOccurred).toHaveBeenCalledTimes(1);
  });

  it("an error toast is felt as an error", () => {
    const feedback = telegram();
    notify.error("no");
    expect(feedback.notificationOccurred).toHaveBeenCalledWith("error");
  });

  it("outside Telegram: nothing, and nothing thrown", () => {
    render(<Button variant="primary">Pay</Button>);
    expect(() => fireEvent.click(screen.getByRole("button", { name: "Pay" }))).not.toThrow();
    expect(() => notify.error("no")).not.toThrow();
  });
});
