import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { moveRow, nextRowKeys } from "../_lib/rows";
import { useRowKeys } from "./useRowKeys";

/**
 * FE-1-a: an editable list whose rows have no id keyed them by index, so
 * removing a middle row moved the next row's focus and half-typed state onto
 * its place (C-30). A row keeps its key through an edit, a remove and a move.
 */

let n = 0;
const fresh = () => `k${++n}`;

describe("moveRow", () => {
  it("moves a row and ignores a move past either end", () => {
    expect(moveRow(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
    expect(moveRow(["a", "b"], 0, -1)).toEqual(["a", "b"]);
  });
});

describe("nextRowKeys", () => {
  const a = { v: "a" };
  const b = { v: "b" };
  const c = { v: "c" };

  it("keeps the keys of the rows left after a middle one is removed", () => {
    expect(nextRowKeys([a, b, c], ["1", "2", "3"], [a, c], fresh)).toEqual(["1", "3"]);
  });

  it("carries a key with its row when rows move", () => {
    expect(nextRowKeys([a, b, c], ["1", "2", "3"], [b, a, c], fresh)).toEqual(["2", "1", "3"]);
  });

  it("lets a row edited in place keep its key", () => {
    expect(nextRowKeys([a, b, c], ["1", "2", "3"], [a, { v: "b2" }, c], fresh)).toEqual(["1", "2", "3"]);
  });

  it("gives an added row a key no other row holds", () => {
    const keys = nextRowKeys([a, b], ["1", "2"], [a, b, c], fresh);
    expect(keys.slice(0, 2)).toEqual(["1", "2"]);
    expect(new Set(keys).size).toBe(3);
  });

  it("keeps primitive rows apart when two are equal", () => {
    const keys = nextRowKeys(["x", "x"], ["1", "2"], ["x", "x", "y"], fresh);
    expect(new Set(keys).size).toBe(3);
  });
});

describe("useRowKeys", () => {
  it("returns the same keys while the rows are the same array", () => {
    const rows = [{ v: 1 }, { v: 2 }];
    const { result, rerender } = renderHook(({ list }) => useRowKeys(list), { initialProps: { list: rows } });
    const first = result.current;
    rerender({ list: rows });
    expect(result.current).toBe(first);
  });

  it("drops only the removed row's key", () => {
    const rows = [{ v: 1 }, { v: 2 }, { v: 3 }];
    const { result, rerender } = renderHook(({ list }) => useRowKeys(list), { initialProps: { list: rows } });
    const [k1, , k3] = result.current;
    act(() => rerender({ list: [rows[0], rows[2]] }));
    expect(result.current).toEqual([k1, k3]);
  });
});
