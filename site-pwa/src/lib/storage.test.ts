import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { StorageKeys, readStored, readStoredJson, storageReadScript, writeStored, writeStoredJson } from "./storage";

const page = z.object({ href: z.string() });

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

describe("lib/storage (FE-1-l)", () => {
  it("writes and reads a key in its own area, and null removes it", () => {
    writeStored(StorageKeys.returnTo, "/wallet");
    expect(sessionStorage.getItem(StorageKeys.returnTo.key)).toBe("/wallet");
    expect(localStorage.getItem(StorageKeys.returnTo.key)).toBeNull();
    expect(readStored(StorageKeys.returnTo)).toBe("/wallet");
    writeStored(StorageKeys.returnTo, null);
    expect(readStored(StorageKeys.returnTo)).toBeNull();
  });

  it("answers null and does not throw when the browser refuses storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    expect(readStored(StorageKeys.displayZone)).toBeNull();
    expect(writeStored(StorageKeys.displayZone, "Asia/Tehran")).toBe(false);
  });

  it("parses JSON with the schema and treats a bad shape or bad JSON as nothing kept", () => {
    writeStoredJson(StorageKeys.recentPages, [{ href: "/wheel" }]);
    expect(readStoredJson(StorageKeys.recentPages, z.array(page))).toEqual([{ href: "/wheel" }]);
    localStorage.setItem(StorageKeys.recentPages.key, JSON.stringify([{ href: 7 }]));
    expect(readStoredJson(StorageKeys.recentPages, z.array(page))).toBeNull();
    localStorage.setItem(StorageKeys.recentPages.key, "{not json");
    expect(readStoredJson(StorageKeys.recentPages, z.array(page))).toBeNull();
  });

  it("gives every key its own name", () => {
    const names = Object.values(StorageKeys).map((k) => `${k.area}:${k.key}`);
    expect(new Set(names).size).toBe(names.length);
  });

  it("reads the same value from a pre-paint script, and null when storage throws", () => {
    sessionStorage.setItem(StorageKeys.miniAppMarker.key, "bale");
    expect(new Function(`return ${storageReadScript(StorageKeys.miniAppMarker)};`)()).toBe("bale");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(new Function(`return ${storageReadScript(StorageKeys.miniAppMarker)};`)()).toBeNull();
  });
});
