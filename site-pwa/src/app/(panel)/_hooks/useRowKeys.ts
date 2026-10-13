import { useState } from "react";
import { nextRowKeys } from "../_lib/rows";

let issued = 0;
const freshKey = () => `row-${++issued}`;

/**
 * A stable React key per row of an editable list whose rows have no id, so a
 * removed or moved row takes its focus and state with it instead of handing
 * them to its neighbour. Rows are compared one by one, so a fallback `[]` or a
 * copy of the same rows is no change; rows rebuilt as new objects every render
 * would re-key every render — pass the state's own rows.
 */
export function useRowKeys<T>(rows: readonly T[]): readonly string[] {
  const [memo, setMemo] = useState(() => ({ rows, keys: rows.map(freshKey) }));
  if (memo.rows.length === rows.length && rows.every((row, i) => row === memo.rows[i])) return memo.keys;
  // Storing what the last render saw, as React's docs do for previous props.
  const next = { rows, keys: nextRowKeys(memo.rows, memo.keys, rows, freshKey) };
  setMemo(next);
  return next.keys;
}
