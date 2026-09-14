"use client";

import type { CSSProperties, ReactNode } from "react";
import { confettiBurst } from "../_lib/celebration";

export interface PaymentResultCardProps {
  /** `success` for a settled payment, `failure` for one that is not, `pending` for one not yet known (F-093-l). */
  tone: "success" | "failure" | "pending";
  /**
   * Burst the confetti. Only a payment settled on *this* visit — a reload with
   * `?already=1` says so quietly (contract.payment-result.md rule 3).
   */
  celebrate?: boolean;
  /** Already translated. */
  title: string;
  message: string;
  children?: ReactNode;
  actions: ReactNode;
}

const TONE = {
  success: {
    vars: { "--pay-tone": "var(--accent-primary)", "--pay-glow": "var(--accent-glow)" },
    text: "text-primary",
    disc: "var(--leaf-bg)",
    heading: "text-text-primary",
  },
  failure: {
    vars: { "--pay-tone": "var(--error-color)", "--pay-glow": "var(--error-bg)" },
    text: "text-error",
    disc: "var(--error-bg)",
    heading: "text-error",
  },
  // Theme green like success — the money is safe — with a clock, not a tick.
  pending: {
    vars: { "--pay-tone": "var(--accent-primary)", "--pay-glow": "var(--accent-glow)" },
    text: "text-primary",
    disc: "var(--leaf-bg)",
    heading: "text-text-primary",
  },
} as const;

/** Computed once: the burst is deterministic, and the same on server and client. */
const CONFETTI = confettiBurst(26);

/** Where the four sparkles sit around the emblem, and when each one blinks. */
const TWINKLES = [
  { top: "6%", left: "14%", delay: "1.3s", size: 10 },
  { top: "18%", left: "84%", delay: "1.9s", size: 8 },
  { top: "74%", left: "6%", delay: "2.5s", size: 7 },
  { top: "82%", left: "88%", delay: "1.6s", size: 11 },
] as const;

/** Staggered entrance for everything under the emblem, in ms. */
const rise = (delay: number): CSSProperties => ({ animationDelay: `${delay}ms` });

/**
 * The frame both result pages share (F-093-f).
 *
 * One component rather than two near-identical pages: legacy's success and
 * failure screens were 200-line copies of each other, which is how the failure
 * one ended up importing `PaymentSuccessPage` under the other's name and how
 * only one of them ever got the animation work.
 *
 * The motion is CSS (`globals.css`, `pay-*`): the ring draws, the mark draws,
 * the emblem pops or shakes, and — on a fresh success — the waves and the
 * confetti go out. Every piece of it is `aria-hidden`; the outcome is the
 * heading.
 */
export function PaymentResultCard({
  tone,
  celebrate = false,
  title,
  message,
  children,
  actions,
}: PaymentResultCardProps) {
  const style = TONE[tone];
  const success = tone === "success";
  const pending = tone === "pending";

  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-md items-center p-4 md:p-8">
      <div
        style={style.vars as CSSProperties}
        className="pay-card relative w-full rounded-[2rem] border border-card-border bg-card-bg px-6 pt-10 pb-6 text-center shadow-[0_24px_60px_-20px_var(--card-shadow)] backdrop-blur-xl sm:px-8"
      >
        {/* A wash of the outcome's colour behind the emblem. */}
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden rounded-[2rem]">
          <div
            className="absolute inset-x-0 top-0 h-48 opacity-70"
            style={{ background: "radial-gradient(120% 100% at 50% 0%, var(--pay-glow), transparent 70%)" }}
          />
        </div>

        <div aria-hidden className="relative mx-auto size-28">
          <span className="pay-halo absolute -inset-6 rounded-full" />

          {success && celebrate && (
            <>
              <span className="pay-ripple absolute inset-0 rounded-full" style={{ animationDelay: "950ms" }} />
              <span className="pay-ripple absolute inset-0 rounded-full" style={{ animationDelay: "1150ms" }} />
              {CONFETTI.map((piece, i) => (
                <span
                  key={i}
                  className="pay-confetti"
                  style={
                    {
                      "--dx": `${piece.dx}px`,
                      "--dy": `${piece.dy}px`,
                      "--rot": `${piece.rotate}deg`,
                      width: piece.shape === "dot" ? piece.size : piece.size * 0.45,
                      height: piece.size,
                      borderRadius: piece.shape === "dot" ? "9999px" : "2px",
                      background: piece.color,
                      animationDelay: `${950 + piece.delay}ms`,
                    } as CSSProperties
                  }
                />
              ))}
            </>
          )}

          {success &&
            TWINKLES.map((s, i) => (
              <svg
                key={i}
                viewBox="0 0 24 24"
                width={s.size}
                height={s.size}
                className="pay-twinkle absolute text-primary"
                style={{ top: s.top, left: s.left, animationDelay: s.delay }}
              >
                <path fill="currentColor" d="M12 0l2.6 9.4L24 12l-9.4 2.6L12 24l-2.6-9.4L0 12l9.4-2.6z" />
              </svg>
            ))}

          <div className={`relative size-full ${success || pending ? "pay-emblem-success" : "pay-emblem-failure"}`}>
            <svg viewBox="0 0 112 112" className={`size-full ${style.text}`}>
              <circle className="pay-disc" cx="56" cy="56" r="50" fill={style.disc} />
              <circle
                className="pay-stroke"
                cx="56"
                cy="56"
                r="44"
                fill="none"
                stroke="currentColor"
                strokeWidth="5"
                strokeLinecap="round"
                pathLength={1}
                transform="rotate(-90 56 56)"
                style={{ animationDelay: "150ms" }}
              />
              {pending ? (
                // Clock hands, pulsing while billing keeps asking. No draw-in:
                // two animations on one element would fight over `animation`.
                <path
                  className="motion-safe:animate-pulse"
                  d="M56 34v24l15 9"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ) : success ? (
                <path
                  className="pay-stroke"
                  d="M36 57.5 50 71l27-29"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  pathLength={1}
                  style={{ animationDelay: "560ms", animationDuration: "380ms" }}
                />
              ) : (
                <>
                  <path
                    className="pay-stroke"
                    d="M41 41 71 71"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="7"
                    strokeLinecap="round"
                    pathLength={1}
                    style={{ animationDelay: "560ms", animationDuration: "240ms" }}
                  />
                  <path
                    className="pay-stroke"
                    d="M71 41 41 71"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="7"
                    strokeLinecap="round"
                    pathLength={1}
                    style={{ animationDelay: "720ms", animationDuration: "240ms" }}
                  />
                </>
              )}
            </svg>
          </div>
        </div>

        {/* The outcome is announced, not just drawn: a payer who cannot see the
            emblem still hears which of the two pages they landed on. */}
        <h1
          role="status"
          className={`pay-rise relative mt-7 text-2xl leading-tight font-extrabold ${style.heading}`}
          style={rise(600)}
        >
          {title}
        </h1>
        <p className="pay-rise relative mx-auto mt-2 max-w-xs text-sm leading-6 text-text-secondary" style={rise(700)}>
          {message}
        </p>
        {children && (
          <div className="pay-rise relative" style={rise(820)}>
            {children}
          </div>
        )}
        <div className="pay-rise relative mt-7 flex flex-col gap-2" style={rise(940)}>
          {actions}
        </div>
      </div>
    </div>
  );
}
