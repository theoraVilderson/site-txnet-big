import { describe, expect, it } from "vitest";
import {
  isValidJsonObject,
  toEnglishDigits,
} from "./helper";

describe("toEnglishDigits", () => {
  it.each([
    ["persian digits", "۰۱۲۳۴۵۶۷۸۹", "0123456789"],
    ["a phone number", "۰۹۱۲۱۲۳۴۵۶۷", "09121234567"],
    ["digits inside persian text", "کد شما ۱۲۳۴۵۶ است", "کد شما 123456 است"],
    ["already english", "0912", "0912"],
    ["mixed scripts", "۱2۳4", "1234"],
    ["no digits at all", "سلام", "سلام"],
    ["punctuation is untouched", "۱۲۳/۴۵", "123/45"],
  ])("%s: %p -> %p", (_label, input, expected) => {
    expect(toEnglishDigits(input)).toBe(expected);
  });

  it.each([
    ["empty string", ""],
    ["undefined", undefined as unknown as string],
    ["null", null as unknown as string],
  ])("%s returns an empty string rather than throwing", (_label, input) => {
    expect(toEnglishDigits(input)).toBe("");
  });

  it("is idempotent", () => {
    const once = toEnglishDigits("کد ۱۲۳");
    expect(toEnglishDigits(once)).toBe(once);
  });

  describe("Arabic-Indic digits are converted too", () => {
    // U+0660-U+0669 — what an Arabic keyboard produces — beside the Persian
    // U+06F0-U+06F9. The gap this block used to pin was closed by c2a445d6
    // (the code boxes take any digits); this is the string `parseInt` reads.
    it.each([
      ["arabic-indic zero to nine", "٠١٢٣٤٥٦٧٨٩", "0123456789"],
      ["arabic-indic phone", "٠٩١٢١٢٣٤٥٦٧", "09121234567"],
    ])("%s becomes ASCII", (_label, input, ascii) => {
      expect(toEnglishDigits(input)).toBe(ascii);
    });
  });
});

describe("isValidJsonObject", () => {
  describe("plain objects", () => {
    it("is true for an empty object", () => {
      expect(isValidJsonObject({})).toBe(true);
    });

    it("is true for an object with keys", () => {
      expect(isValidJsonObject({ a: 1, b: "test" })).toBe(true);
    });

    it("is true for a nested object", () => {
      expect(isValidJsonObject({ user: { name: "Ali" } })).toBe(true);
    });

    it("is true for an object made with Object.create(null)", () => {
      expect(isValidJsonObject(Object.create(null))).toBe(true);
    });
  });

  describe("anything else", () => {
    it("is false for null", () => {
      expect(isValidJsonObject(null)).toBe(false);
    });

    it("is false for an array", () => {
      expect(isValidJsonObject([])).toBe(false);
      expect(isValidJsonObject([1, 2, 3])).toBe(false);
    });

    it("is false for a primitive", () => {
      expect(isValidJsonObject(undefined)).toBe(false);
      expect(isValidJsonObject("string")).toBe(false);
      expect(isValidJsonObject(123)).toBe(false);
      expect(isValidJsonObject(true)).toBe(false);
      expect(isValidJsonObject(Symbol("id"))).toBe(false);
      expect(isValidJsonObject(BigInt(10))).toBe(false);
    });

    it("is false for a function", () => {
      expect(isValidJsonObject(() => {})).toBe(false);
      expect(isValidJsonObject(function () {})).toBe(false);
    });
  });
});
