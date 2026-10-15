import { scaleLinear } from "@visx/scale";

/** The space around a plot for its axes; `end` grows when lines are labelled at their ends (rule 5). */
export const MARGIN = { top: 8, bottom: 24, start: 44, end: 8 } as const;
/** Room for a direct label at a line's end. */
export const END_LABEL_ROOM = 72;
/** At most this many y ticks (rule 7). */
export const Y_TICKS = 5;
/** A tick on the time axis at most every this many pixels. */
const X_TICK_SPACING = 72;

/** Every finite number in `values`, for a domain. */
export const finite = (values: readonly (number | null)[]) => values.filter((v): v is number => v !== null && Number.isFinite(v));

/**
 * A y scale from 0 (rule 7: a bar or an area starts at 0; a line keeps 0 too,
 * so a change is never drawn bigger than it is), niced to at most five ticks.
 */
export function yScaleOf(values: readonly number[], innerHeight: number) {
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  return scaleLinear<number>({ domain: [min, max === min ? min + 1 : max], range: [innerHeight, 0], nice: Y_TICKS });
}

/**
 * At most five y ticks (rule 7). d3's `ticks(5)` is a hint and can answer
 * eight; ask for fewer until the answer fits.
 */
export function yTicks(scale: { ticks: (count: number) => number[] }): number[] {
  for (let ask = Y_TICKS; ask > 1; ask--) {
    const ticks = scale.ticks(ask);
    if (ticks.length <= Y_TICKS) return ticks;
  }
  return scale.ticks(1);
}

/** Which of `count` time points get a label on the axis at this width. */
export function xTickIndexes(count: number, innerWidth: number): number[] {
  if (count <= 1) return count === 1 ? [0] : [];
  const every = Math.max(1, Math.ceil(count / Math.max(2, Math.floor(innerWidth / X_TICK_SPACING))));
  const ticks: number[] = [];
  for (let i = 0; i < count; i += every) ticks.push(i);
  if (ticks[ticks.length - 1] !== count - 1 && count - 1 - ticks[ticks.length - 1] >= every / 2) ticks.push(count - 1);
  return ticks;
}
