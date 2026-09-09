import { KeyObject } from "crypto";
import { JWK, JWTPayload, SignJWT } from "jose";
import { NextRequest } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { toGregorian } from "jalaali-js";
import { ZodError } from "zod";

export function getIpFromHeader(headers: NextRequest["headers"]) {
  return headers.get("x-forwarded-for")?.split?.(",")?.shift?.() || "127.0.0.1";
}
export function getHostFromHeader(headers: NextRequest["headers"]) {
  return headers.get("x-forwarded-host") ?? headers.get("host") ?? "";
}

export async function generateJIT<PayloadType>(
  payload: Omit<PayloadType, keyof JWTPayload>,
  key: Uint8Array<ArrayBufferLike> | CryptoKey | KeyObject | JWK,
  expire: string | number,
) {
  const jti = uuidv4(); // تولید شناسه یکتا برای این توکن خاص

  const token = await new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setJti(jti) // ست کردن JTI
    .setIssuedAt()
    .setExpirationTime(expire) // انقضای خود توکن
    .sign(key);

  return { token, jti };
}
export function getEnv(key: string) {
  return process.env[key]!;
}
// lib/formatters.ts

export const formatPricetoToman = (amountInRial: number): string => {
  // 1. تبدیل به تومان
  const toman = toToman(amountInRial);

  // 2. جدا کردن سه رقم سه رقم (مثلا: 10,000)
  return toman.toLocaleString("fa-IR");
};

export const toToman = (amountInRial: number): number => {
  return Math.ceil(amountInRial / 10);
};
export const toEnglishDigits = (str: string) => {
  if (!str) return "";
  return str.replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d).toString());
};

/**
 * تبدیل رشته تاریخ شمسی به آبجکت Date میلادی
 * @param persianDateStr رشته تاریخ مثل "1402/01/01"
 * @param isEndOfDay آیا زمان پایان روز باشد؟ (برای فیلتر "تا تاریخ")
 */
export function parsePersianDate(
  persianDateStr: string,
  isEndOfDay: boolean = false,
): Date | undefined {
  console.log(persianDateStr, "geelow");
  if (!persianDateStr) return undefined;

  try {
    // حذف جداکننده‌ها و تبدیل به اعداد
    // فرض بر این است که ورودی به صورت YYYY/MM/DD یا YYYY-MM-DD است
    const parts = persianDateStr.split(/[/-]/);

    if (parts.length !== 3) return undefined;

    const jy = parseInt(parts[0], 10);
    const jm = parseInt(parts[1], 10);
    const jd = parseInt(parts[2], 10);

    // تبدیل به میلادی
    const { gy, gm, gd } = toGregorian(jy, jm, jd);

    // ساخت آبجکت تاریخ
    // نکته: ماه در جاوااسکریپت از 0 شروع می‌شود (0 = ژانویه) پس gm - 1 می‌کنیم
    const date = new Date(gy, gm - 1, gd);
    console.log(date, jy, jm, jd);
    if (isEndOfDay) {
      // تنظیم روی آخرین لحظه روز (23:59:59.999)
      date.setHours(23, 59, 59, 999);
    } else {
      // تنظیم روی شروع روز (00:00:00.000)
      date.setHours(0, 0, 0, 0);
    }

    return date;
  } catch (error) {
    console.error("Invalid Persian Date:", persianDateStr);
    return undefined;
  }
}

/**
 * The panel's translator — `useLocale().t` from `@/context/LocaleContext`.
 * Typed here rather than imported so this module stays free of React.
 */
export type Translate = (
  ns: string,
  key: string,
  vars?: Record<string, string | number>,
) => string;

/** The namespace every validation string is authored in (`locales/frontend`). */
export const VALIDATIONS_NS = "validations";

/** Shown when the argument is not a ZodError at all. */
export const UNKNOWN_VALIDATION_KEY = "unknown";

interface ZodFormatOptions {
  /**
   * Prefix each message with the field path, e.g. `username: <message>`.
   * @default true
   */
  withPath?: boolean;

  /**
   * Separator between messages.
   * @default "\n"
   */
  separator?: string;

  /**
   * Translator for the active locale. Omitted -> every string comes back as
   * its raw `validations` key, which is exactly what `useLocale().t` does on a
   * miss and what the bot's renderer does with an untranslated key: a visible
   * key, never a sentence in one fixed language.
   */
  t?: Translate;
}

/**
 * Render a `ZodError` as one string in the user's language.
 *
 * Issue messages are looked up in the `validations` namespace, so a schema
 * authored as `z.string().min(3, "fields.username.tooShort")` speaks whatever
 * locale is active. A message that is not a key survives unchanged — `t`
 * returns the key it was given when it finds nothing — so this is safe to put
 * in front of a schema that has not been keyed yet.
 */
export const zodErrorToString = (
  error: ZodError,
  options: ZodFormatOptions = {},
): string => {
  const {
    withPath = true,
    separator = "\n",
    t = (_ns, key) => key,
  } = options;

  if (!error || !error.issues) {
    return t(VALIDATIONS_NS, UNKNOWN_VALIDATION_KEY);
  }

  return error.issues
    .map((issue) => {
      const message = t(VALIDATIONS_NS, issue.message);

      if (withPath && issue.path.length > 0) {
        return `${issue.path.join(".")}: ${message}`;
      }

      return message;
    })
    .join(separator);
};
