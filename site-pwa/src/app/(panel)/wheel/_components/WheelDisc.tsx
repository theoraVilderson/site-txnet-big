"use client";

/** Two alternating fills from the theme's green tokens (no gold on the panel's controls). */
const FILLS = ["var(--accent-primary)", "var(--leaf-bg)"];
const TEXT = ["#ffffff", "var(--text-primary)"];
const R = 100;

/**
 * The wheel itself: slot 1 starts at the pointer and the slots run clockwise,
 * the layout `slotUnderPointer` / `landingRotation` assume. It turns to the
 * `rotation` it is given and decides nothing.
 */
export function WheelDisc({ slots, rotation, durationMs }: { slots: readonly string[]; rotation: number; durationMs: number }) {
  const seg = 360 / slots.length;
  const point = (deg: number, r = R) => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return [R + r * Math.cos(rad), R + r * Math.sin(rad)];
  };
  // An odd count would put two same-coloured slots side by side at the seam.
  const fill = (i: number) => (slots.length % 2 === 1 && i === slots.length - 1 ? "var(--bg-inner)" : FILLS[i % 2]);
  const ink = (i: number) => (slots.length % 2 === 1 && i === slots.length - 1 ? "var(--text-primary)" : TEXT[i % 2]);

  return (
    <div className="relative w-full max-w-[320px]">
      <svg viewBox="-4 -14 208 218" className="w-full" aria-hidden>
        <g
          style={{
            transform: `rotate(${rotation}deg)`,
            transformOrigin: `${R}px ${R}px`,
            transition: `transform ${durationMs}ms cubic-bezier(0.17, 0.67, 0.12, 1)`,
          }}
        >
          {slots.map((label, i) => {
            const [x1, y1] = point(i * seg);
            const [x2, y2] = point((i + 1) * seg);
            const mid = (i + 0.5) * seg;
            const [tx, ty] = point(mid, R * 0.62);
            return (
              <g key={i}>
                <path
                  d={`M${R},${R} L${x1},${y1} A${R},${R} 0 ${seg > 180 ? 1 : 0} 1 ${x2},${y2} Z`}
                  fill={fill(i)}
                  stroke="var(--card-border)"
                  strokeWidth={0.8}
                />
                <text
                  x={tx}
                  y={ty}
                  fill={ink(i)}
                  fontSize={slots.length > 10 ? 6 : 8}
                  fontWeight={700}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  transform={`rotate(${mid} ${tx} ${ty})`}
                >
                  {label.length > 14 ? `${label.slice(0, 13)}…` : label}
                </text>
              </g>
            );
          })}
          <circle cx={R} cy={R} r={12} fill="var(--card-bg)" stroke="var(--card-border)" />
        </g>
        <path d={`M${R - 8},-12 L${R + 8},-12 L${R},6 Z`} fill="var(--text-primary)" />
      </svg>
    </div>
  );
}
