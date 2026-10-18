import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { usePackageTexts } from "./usePackageTexts";

/**
 * A package's name and description in the reader's language (ADR-0154 (7),
 * PK-1-d): the one resolver every page that names a package reads through.
 *
 * The server sends keys, never text in a language: the reader's language
 * first, then the package's source language, then the `name` column — which is
 * the source text, so a package from before PK-1-c still has a name, and a
 * locale route that does not answer costs the translation, never the page.
 */

const lang = { current: "en" };
vi.mock("@/context/LocaleContext", () => ({ useLocale: () => ({ lang: lang.current }) }));

const GOLD = { name: "طلایی", nameKey: "packages.p_1.name", descriptionKey: "packages.p_1.description", sourceLang: "fa" };
const OLD = { name: "Starter", nameKey: "packages.p_2.name", descriptionKey: null, sourceLang: "fa" };

/** The panel's i18n route, `GET /api/i18n/<lang>/packages`, nested as locale-service serves it. */
function serve(byLang: Record<string, Record<string, Record<string, string>>>) {
  const asked: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const [, , , l, ns] = url.split("/");
      asked.push(`${l}/${ns}`);
      const body = byLang[l];
      return body ? new Response(JSON.stringify(body)) : new Response("{}", { status: 404 });
    }),
  );
  return asked;
}

afterEach(() => {
  vi.unstubAllGlobals();
  lang.current = "en";
});

describe("usePackageTexts", () => {
  it("names a package in the reader's language, with its description", async () => {
    const asked = serve({ en: { p_1: { name: "Gold", description: "To start with" } } });
    const { result } = renderHook(() => usePackageTexts());
    await waitFor(() => expect(result.current.name(GOLD)).toBe("Gold"));
    expect(result.current.description(GOLD)).toBe("To start with");
    expect(asked).toEqual(["en/packages"]);
  });

  it("falls back to the source language for a description, and to the name column for a name", async () => {
    serve({ en: {}, fa: { p_1: { description: "برای شروع" } } });
    const { result } = renderHook(() => usePackageTexts(["fa"]));
    await waitFor(() => expect(result.current.description(GOLD)).toBe("برای شروع"));
    expect(result.current.name(GOLD)).toBe("طلایی");
    expect(result.current.name(OLD)).toBe("Starter");
    expect(result.current.description(OLD)).toBeNull();
  });

  it("shows the name column while the texts load, and when the route fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))));
    const { result } = renderHook(() => usePackageTexts());
    expect(result.current.name(GOLD)).toBe("طلایی");
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(result.current.name(GOLD)).toBe("طلایی");
  });

  it("reads the new language when the reader switches", async () => {
    serve({ en: { p_1: { name: "Gold" } }, de: { p_1: { name: "Gold (de)" } } });
    const { result, rerender } = renderHook(() => usePackageTexts());
    await waitFor(() => expect(result.current.name(GOLD)).toBe("Gold"));
    lang.current = "de";
    rerender();
    await waitFor(() => expect(result.current.name(GOLD)).toBe("Gold (de)"));
  });
});
