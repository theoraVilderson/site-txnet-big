/**
 * The confetti a settled payment bursts with (F-093-f).
 *
 * Deterministic on purpose: the page renders on the server and hydrates in the
 * browser, so a `Math.random()` burst would differ between the two and React
 * would throw the markup away on the one page a payer celebrates on. A fixed
 * seed gives an irregular-looking burst that is the same on both sides.
 */

export interface ConfettiPiece {
  /** Where it lands, in px from the emblem's centre. */
  dx: number;
  dy: number;
  /** Degrees of spin on the way. */
  rotate: number;
  /** ms before it leaves. */
  delay: number;
  /** px — the long side of a strip, the diameter of a dot. */
  size: number;
  shape: "strip" | "dot";
  /** A theme token, so every theme bursts in its own colours — never gold. */
  color: string;
}

const COLORS = ["var(--accent-primary)", "var(--text-secondary)", "var(--text-label)", "var(--text-primary)"];

/** mulberry32: small, fast and good enough to make a burst look hand-thrown. */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function confettiBurst(count: number, seed = 0x7a17): ConfettiPiece[] {
  const random = seeded(seed);
  return Array.from({ length: count }, (_, i) => {
    // Evenly around the circle, then jittered, so no side comes out bare.
    const angle = ((i + random() * 0.8) / count) * Math.PI * 2;
    const distance = 80 + random() * 80;
    return {
      dx: Math.round(Math.cos(angle) * distance),
      dy: Math.round(Math.sin(angle) * distance),
      rotate: Math.round((random() - 0.5) * 720),
      delay: Math.round(random() * 120),
      size: Math.round(6 + random() * 5),
      shape: i % 3 === 0 ? "dot" : "strip",
      color: COLORS[i % COLORS.length],
    };
  });
}
