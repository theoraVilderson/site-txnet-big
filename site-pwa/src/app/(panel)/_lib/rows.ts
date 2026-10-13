/** `rows` with the one at `i` moved by `by` (−1 up, +1 down); out of range is a no-op. */
export function moveRow<T>(rows: readonly T[], i: number, by: -1 | 1): T[] {
  const j = i + by;
  if (i < 0 || i >= rows.length || j < 0 || j >= rows.length) return [...rows];
  const next = [...rows];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

/**
 * The keys for `rows`, carried over from `prevRows`/`prevKeys` (C-30, FE-1-a).
 * A row still present keeps its key, matched by identity (a primitive by value,
 * equal values in order); a row edited in place is a new object at an index
 * whose old row is gone, and inherits that index's key; anything else is new.
 */
export function nextRowKeys<T>(
  prevRows: readonly T[],
  prevKeys: readonly string[],
  rows: readonly T[],
  fresh: () => string,
): string[] {
  const byRow = new Map<T, string[]>();
  prevRows.forEach((row, i) => byRow.set(row, [...(byRow.get(row) ?? []), prevKeys[i]]));
  const matched = rows.map((row) => byRow.get(row)?.shift());
  const taken = new Set(matched);
  return rows.map((_, i) => matched[i] ?? (prevKeys[i] !== undefined && !taken.has(prevKeys[i]) ? prevKeys[i] : fresh()));
}
