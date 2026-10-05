"use client";

import { useEffect, useRef } from "react";
import { haptic } from "@/lib/haptics";

/** M5: a short burst, small enough for a phone — and no dependency for it. */
export const CONFETTI = { particles: 120, ms: 1600 } as const;

/** The theme's own colours; read at the moment of the burst, so dark mode is right. */
const TOKENS = ["--accent-primary", "--gold-primary", "--success", "--info"] as const;
const FALLBACK = ["#4caf50", "#d4a017", "#2e7d32", "#1e88e5"];

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  spin: number;
  angle: number;
  color: string;
}

/** Thrown up from the bottom centre, fanning out; gravity brings them down. */
export function confettiParticles(count: number, width: number, height: number, colors: readonly string[]): Particle[] {
  return Array.from({ length: count }, (_, i) => {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * (Math.PI * 0.7);
    const speed = height * (0.9 + Math.random() * 0.6);
    return {
      x: width / 2 + (Math.random() - 0.5) * width * 0.2,
      y: height,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: 5 + Math.random() * 5,
      spin: (Math.random() - 0.5) * 12,
      angle: Math.random() * Math.PI,
      color: colors[i % colors.length],
    };
  });
}

function themeColors(): string[] {
  const style = getComputedStyle(document.documentElement);
  return TOKENS.map((name, i) => style.getPropertyValue(name).trim() || FALLBACK[i]);
}

/**
 * A celebration (M5): a canvas of confetti over the page and, in Telegram, a
 * success buzz (M6). Under the reduced motion level (M3) the buzz alone — no
 * confetti is drawn. The canvas ignores the pointer and is removed when the
 * burst ends, whether or not a frame was ever painted.
 */
export function celebrate(): void {
  if (typeof document === "undefined") return;
  haptic.success();
  if (document.documentElement.getAttribute("data-motion") === "reduced") return;

  const canvas = document.createElement("canvas");
  canvas.setAttribute("data-confetti", "");
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:80";
  const width = window.innerWidth;
  const height = window.innerHeight;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  document.body.appendChild(canvas);

  let frame = 0;
  const done = () => {
    if (frame) cancelAnimationFrame(frame);
    canvas.remove();
  };
  window.setTimeout(done, CONFETTI.ms);

  // jsdom and some old webviews have no 2D context: the timer still clears up.
  const ctx = canvas.getContext?.("2d");
  if (!ctx || typeof requestAnimationFrame !== "function") return;
  ctx.scale(ratio, ratio);
  const particles = confettiParticles(CONFETTI.particles, width, height, themeColors());
  const gravity = height * 1.6;
  const start = performance.now();
  let last = start;
  const draw = (now: number) => {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    const fade = Math.max(0, 1 - (now - start) / CONFETTI.ms);
    ctx.clearRect(0, 0, width, height);
    ctx.globalAlpha = Math.min(1, fade * 2);
    for (const p of particles) {
      p.vy += gravity * dt;
      p.vx *= 0.99;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.angle += p.spin * dt;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      ctx.restore();
    }
    if (fade > 0) frame = requestAnimationFrame(draw);
  };
  frame = requestAnimationFrame(draw);
}

/**
 * Celebrates once when `when` turns true, and never again for this mounted
 * view (M5: once per occasion per view) — a re-render or a re-read does not
 * throw a second burst.
 */
export function useCelebration(when: boolean): void {
  const fired = useRef(false);
  useEffect(() => {
    if (!when || fired.current) return;
    fired.current = true;
    celebrate();
  }, [when]);
}
