import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { CatalogAdminApi } from "@/lib/catalog-api";
import { useCatalogData } from "./useCatalogData";

/**
 * The catalog page's data (FE-1-i-a): one read of the six lists, a review
 * count that may fail on its own, and no write from an answer that arrives
 * after the page stopped asking — the load used to run under an
 * `eslint-disable` and wrote whatever came back, however late.
 */

const product = (id: string) => ({ id, key: id, nameKey: `catalog.p.${id}`, sourceLang: "xx", categoryIds: [] });

function fakeApi(overrides: Partial<Record<keyof CatalogAdminApi, unknown>> = {}) {
  return {
    categories: vi.fn(async () => []),
    products: vi.fn(async (q?: { archived?: string }) => (q?.archived ? [product("kept")] : [product("p1")])),
    capabilities: vi.fn(async () => []),
    texts: vi.fn(async () => ({ p: { p1: { name: "One" } } })),
    translations: vi.fn(async () => [{}, {}]),
    ...overrides,
  } as unknown as CatalogAdminApi;
}

describe("useCatalogData", () => {
  it("reads the lists, the names in every language asked, and the review count", async () => {
    const api = fakeApi();
    const { result } = renderHook(() => useCatalogData(api, ["xx", "yy"]));
    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(result.current.data?.products.map((p) => p.id)).toEqual(["p1"]);
    expect(result.current.data?.archived.map((p) => p.id)).toEqual(["kept"]);
    expect(Object.keys(result.current.data?.texts ?? {})).toEqual(["xx", "yy"]);
    await waitFor(() => expect(result.current.pending).toBe(2));
    expect(result.current.error).toBeNull();
  });

  it("keeps the list when the review count fails", async () => {
    const api = fakeApi({ translations: vi.fn(async () => Promise.reject(new Error("down"))) });
    const { result } = renderHook(() => useCatalogData(api, ["xx"]));
    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(result.current.pending).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("reports a failed read, and a reload clears it", async () => {
    let fail = true;
    const api = fakeApi({ categories: vi.fn(async () => (fail ? Promise.reject(new Error("down")) : [])) });
    const { result } = renderHook(() => useCatalogData(api, ["xx"]));
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
    fail = false;
    await act(() => result.current.reload());
    expect(result.current.error).toBeNull();
    expect(result.current.data).not.toBeNull();
  });

  it("drops the old surface's answer when it lands after the new one's", async () => {
    let answerOld: (v: never[]) => void = () => {};
    const oldApi = fakeApi({ categories: vi.fn(() => new Promise((r) => (answerOld = r))) });
    const newApi = fakeApi({ products: vi.fn(async (q?: { archived?: string }) => (q?.archived ? [] : [product("p2")])) });
    const { result, rerender } = renderHook(({ api }) => useCatalogData(api, ["xx"]), { initialProps: { api: oldApi } });
    rerender({ api: newApi });
    await waitFor(() => expect(result.current.data?.products.map((p) => p.id)).toEqual(["p2"]));
    await act(async () => answerOld([]));
    expect(result.current.data?.products.map((p) => p.id)).toEqual(["p2"]);
  });
});
