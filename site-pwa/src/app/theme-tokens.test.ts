// @vitest-environment node
//
// The panel's colour tokens (UX-1-a, panel-web/contract.ux.md K1–K2). Three
// themes and a tenant's brand colour paint the same classes, so a class is only
// safe when its token exists in every one of them and reads on the surface it
// is drawn on. Before this row `text-success` named a token nothing defined (the
// support "live" dot was invisible), and `text-white` sat on a dark-theme accent
// that is light green.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { brandStyle } from "@/lib/branding";

const SRC = join(__dirname, "..");
const CSS = readFileSync(join(__dirname, "globals.css"), "utf8");

/** The body of the block opened by `head`, up to its closing brace. */
function block(head: string, close: string): string {
  const at = CSS.indexOf(head);
  expect(at, `no block ${head}`).toBeGreaterThanOrEqual(0);
  return CSS.slice(at, CSS.indexOf(close, at));
}

const THEMES = {
  light: block('[data-theme="light"] {', "\n  }\n"),
  dark: block('[data-theme="dark"] {', "\n  }\n"),
  ocean: block('[data-theme="ocean"] {', "\n  }\n"),
};
const THEME_MAP = block("@theme {", "\n}\n");

function token(body: string, name: string): string {
  const m = body.match(new RegExp(`--${name}:\\s*([^;]+);`));
  expect(m, `--${name} missing`).not.toBeNull();
  return m![1].trim();
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const TONES = ["success", "warning", "info"] as const;

describe("theme tokens (K1)", () => {
  it.each(Object.entries(THEMES))("%s defines every semantic token", (_, body) => {
    for (const tone of TONES) {
      for (const suffix of ["", "-bg", "-border"]) token(body, `${tone}${suffix}`);
    }
    token(body, "text-on-accent");
    token(body, "text-on-error");
  });

  it("maps every one of them to a Tailwind colour", () => {
    for (const tone of TONES) {
      for (const suffix of ["", "-bg", "-border"]) {
        expect(token(THEME_MAP, `color-${tone}${suffix}`)).toBe(`var(--${tone}${suffix})`);
      }
    }
    expect(token(THEME_MAP, "color-on-accent")).toBe("var(--text-on-accent)");
    expect(token(THEME_MAP, "color-on-error")).toBe("var(--text-on-error)");
  });

  it.each(Object.entries(THEMES))("%s: a tone reads as text on the page", (_, body) => {
    const page = token(body, "bg-inner");
    for (const tone of TONES) expect(contrast(token(body, tone), page)).toBeGreaterThanOrEqual(4.5);
  });

  // 3:1 — the bold labels on a filled control, the bar the light theme's white
  // on green was set at when the palette was approved.
  it.each(Object.entries(THEMES))("%s: a label reads on the accent and on the error colour", (_, body) => {
    expect(contrast(token(body, "text-on-accent"), token(body, "accent-primary"))).toBeGreaterThanOrEqual(3);
    expect(contrast(token(body, "text-on-error"), token(body, "error-color"))).toBeGreaterThanOrEqual(3);
  });

  // A tenant's colour replaces the accent in all three themes at once, so the
  // label on it is chosen from that colour, not left to the theme.
  it.each(["#123abc", "#19a055", "#4ade80", "#ffd54a", "#ffffff", "#000000"])(
    "a brand colour %s carries a label that reads on it",
    (hex) => {
      const style = brandStyle({
        brandName: "Acme",
        logoLightUrl: null,
        logoDarkUrl: null,
        faviconUrl: null,
        ogImageUrl: null,
        primaryColorHex: hex,
        secondaryColorHex: null,
      }) as Record<string, string>;
      expect(contrast(style["--text-on-accent"], hex)).toBeGreaterThanOrEqual(3);
    },
  );
});

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

describe("labels on filled surfaces (K1)", () => {
  it("no line puts text-white on the accent or the error colour", () => {
    const offenders = sources(SRC).flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .map((line, i) => ({ line, at: `${file.slice(SRC.length + 1)}:${i + 1}` }))
        .filter(({ line }) => /\btext-white\b/.test(line) && /\b(bg|from)-(primary|error)\b(?!\/)/.test(line))
        .map(({ at }) => at),
    );
    expect(offenders).toEqual([]);
  });
});

describe("focus ring (K2)", () => {
  it("is one 2px accent outline at a 2px offset", () => {
    const rule = CSS.match(/:focus-visible\s*\{([^}]*)\}/);
    expect(rule, "no :focus-visible rule").not.toBeNull();
    expect(rule![1]).toMatch(/outline:\s*2px solid var\(--accent-primary\)/);
    expect(rule![1]).toMatch(/outline-offset:\s*2px/);
  });
});
