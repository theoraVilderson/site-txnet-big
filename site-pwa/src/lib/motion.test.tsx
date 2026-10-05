// The panel's motion foundation (UX-1-b, panel-web/contract.ux.md M1–M3): one
// set of timings, two levels, and one switch that framer-motion and every CSS
// keyframe in `globals.css` both obey. Before this row reduced motion was nine
// separate `useReducedMotion()` calls and four `@media` blocks, each reading
// the OS and nothing else — so a weak phone inside the Mini App animated as
// much as a desktop, and a person's own choice (UX-1-l) had nowhere to land.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, render, screen } from "@testing-library/react";
import { motion } from "framer-motion";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PanelMotion } from "@/app/(panel)/_components/PanelMotion";
import {
  DURATION,
  EASE,
  MOTION_SCRIPT,
  SHEET_SPRING,
  fadeRise,
  pop,
  resolveMotionLevel,
  staggerDelay,
} from "./motion";

describe("tokens (M1)", () => {
  it("are the contract's figures", () => {
    expect(DURATION).toEqual({ fast: 0.12, base: 0.2, slow: 0.32 });
    expect(EASE).toEqual({ standard: [0.2, 0.8, 0.2, 1], exit: [0.4, 0, 1, 1] });
    expect(SHEET_SPRING).toEqual({ type: "spring", stiffness: 380, damping: 34 });
  });

  it("staggers 40ms apart, the first 8 children only", () => {
    expect([0, 1, 7, 8, 30].map((i) => staggerDelay(i, "full"))).toEqual([0, 0.04, 0.28, 0.28, 0.28]);
    expect(staggerDelay(5, "reduced")).toBe(0);
  });
});

describe("the level (M2)", () => {
  const plain = { preference: "system", osReduced: false, miniApp: false, cores: 8, memoryGb: 8 } as const;

  it.each([
    ["nothing asks for less", {}, "full"],
    ["the OS asks for less", { osReduced: true }, "reduced"],
    ["the person chose full over the OS", { preference: "full", osReduced: true }, "full"],
    ["the person chose reduced", { preference: "reduced" }, "reduced"],
    ["a Mini App on 4 cores", { miniApp: true, cores: 4 }, "reduced"],
    ["a Mini App on 2 GB", { miniApp: true, memoryGb: 2 }, "reduced"],
    ["a Mini App on a strong phone", { miniApp: true }, "full"],
    ["a weak browser that is not the Mini App", { cores: 2, memoryGb: 1 }, "full"],
    ["a Mini App whose device says nothing", { miniApp: true, cores: undefined, memoryGb: undefined }, "full"],
    ["a weak Mini App whose person chose full", { preference: "full", miniApp: true, cores: 2 }, "full"],
  ] as const)("%s", (_, over, level) => {
    expect(resolveMotionLevel({ ...plain, ...over })).toBe(level);
  });
});

describe("presets (M1, M3)", () => {
  it("fadeRise rises 8px at full and only fades, within 120ms, at reduced", () => {
    expect(fadeRise("full").hidden).toEqual({ opacity: 0, y: 8 });
    const reduced = fadeRise("reduced");
    expect(reduced.hidden).toEqual({ opacity: 0 });
    expect(Object.keys(reduced.shown).filter((k) => k !== "transition")).toEqual(["opacity"]);
    expect((reduced.shown as { transition: { duration: number } }).transition.duration).toBeLessThanOrEqual(0.12);
  });

  it("pop scales at full and only fades at reduced", () => {
    expect(pop("full").hidden).toMatchObject({ scale: expect.any(Number) });
    expect(pop("reduced").hidden).toEqual({ opacity: 0 });
  });
});

// The switch has to be on <html> before the first paint, or the payment
// result's CSS entrances run for a frame before React gets there.
function setEnv(opts: { osReduced: boolean; cores?: number; memoryGb?: number; miniApp?: boolean }) {
  const listeners = new Set<() => void>();
  const mql = {
    matches: opts.osReduced,
    media: "(prefers-reduced-motion: reduce)",
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  window.matchMedia = ((q: string) => ({ ...mql, media: q, matches: mql.matches })) as never;
  Object.defineProperty(navigator, "hardwareConcurrency", { value: opts.cores ?? 8, configurable: true });
  Object.defineProperty(navigator, "deviceMemory", { value: opts.memoryGb ?? 8, configurable: true });
  window.sessionStorage.clear();
  if (opts.miniApp) window.sessionStorage.setItem("txnet.miniApp", "telegram");
  return {
    flip(osReduced: boolean) {
      mql.matches = osReduced;
      listeners.forEach((fn) => fn());
    },
  };
}

const html = () => document.documentElement;

describe("the switch (M3)", () => {
  beforeEach(() => html().removeAttribute("data-motion"));
  afterEach(() => html().removeAttribute("data-motion"));

  it("the pre-paint script marks <html> for a reduced level and only then", () => {
    setEnv({ osReduced: true });
    new Function(MOTION_SCRIPT)();
    expect(html().getAttribute("data-motion")).toBe("reduced");

    html().removeAttribute("data-motion");
    setEnv({ osReduced: false, miniApp: true, cores: 4 });
    new Function(MOTION_SCRIPT)();
    expect(html().getAttribute("data-motion")).toBe("reduced");

    html().removeAttribute("data-motion");
    setEnv({ osReduced: false });
    new Function(MOTION_SCRIPT)();
    expect(html().hasAttribute("data-motion")).toBe(false);
  });

  it("the panel keeps <html> and framer-motion on the level as the OS changes", () => {
    const env = setEnv({ osReduced: false });
    render(
      <PanelMotion>
        <motion.div data-testid="m" initial={{ x: 0 }} animate={{ x: 10 }} />
      </PanelMotion>,
    );
    expect(html().hasAttribute("data-motion")).toBe(false);

    act(() => env.flip(true));
    expect(html().getAttribute("data-motion")).toBe("reduced");
    expect(screen.getByTestId("m")).toBeInTheDocument();

    act(() => env.flip(false));
    expect(html().hasAttribute("data-motion")).toBe(false);
  });
});

describe("globals.css obeys the switch, not the OS (M3)", () => {
  const css = readFileSync(join(__dirname, "../app/globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

  it("has no reduced-motion media query of its own", () => {
    expect(css).not.toMatch(/prefers-reduced-motion/);
  });

  it("stops or fades every keyframe it runs", () => {
    const reducedParts = new Set<string>();
    const animated: string[] = [];
    for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const parts = sel.split(",").map((p) => p.trim().replace(/\s+/g, " "));
      for (const p of parts) {
        if (p.startsWith('[data-motion="reduced"] ')) reducedParts.add(p.slice('[data-motion="reduced"] '.length));
      }
      if (!/animation(-name)?:\s*(?!none\b)[a-zA-Z]/.test(body)) continue;
      // The autofill hooks are a detector the field's JS listens for, not motion.
      animated.push(...parts.filter((p) => !p.startsWith("[data-motion") && !/autofill/.test(p)));
    }
    expect(animated.length).toBeGreaterThan(20);
    const uncovered = animated.filter((p) => {
      const words = p.split(" ");
      return !words.some((_, i) => reducedParts.has(words.slice(i).join(" ")));
    });
    expect(uncovered).toEqual([]);
  });

  it("points Tailwind's motion variants at the same switch", () => {
    expect(css).toMatch(/@custom-variant motion-reduce [^;]*\[data-motion="reduced"\]/);
    expect(css).toMatch(/@custom-variant motion-safe [^;]*:not\(\[data-motion="reduced"\]\)/);
  });
});
