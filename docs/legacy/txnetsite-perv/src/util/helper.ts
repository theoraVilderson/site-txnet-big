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
export function sendAsRes<DataType>(
  data: DataType,
  msg?: string,
  ok: boolean = false
) {
  msg = !msg ? (ok ? "successful" : "failed") : msg;
  return {
    status: ok ? "ok" : "nok",
    msg,
    data,
  };
}
export async function generateJIT<PayloadType>(
  payload: Omit<PayloadType, keyof JWTPayload>,
  key: Uint8Array<ArrayBufferLike> | CryptoKey | KeyObject | JWK,
  expire: string | number
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
  isEndOfDay: boolean = false
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

interface ZodFormatOptions {
  /**
   * آیا نام فیلد قبل از پیام خطا بیاید؟
   * @default false
   * @example "username: نام کاربری الزامی است"
   */
  withPath?: boolean;

  /**
   * کاراکتر جداکننده خطاها
   * @default "\n"
   */
  separator?: string;
}

/**
 * تبدیل ارورهای Zod به یک رشته متنی تمیز
 * @param error آبجکت ارور دریافت شده از zod
 * @param options تنظیمات اختیاری (نام فیلد، جداکننده)
 */
export const zodErrorToString = (
  error: ZodError,
  options: ZodFormatOptions = {}
): string => {
  const { withPath = true, separator = "\n" } = options;

  // اگر ارور نال بود یا فرمت ZodError نداشت
  if (!error || !error.issues) {
    return "خطای ناشناخته در اعتبارسنجی";
  }

  return error.issues
    .map((issue) => {
      const message = issue.message;

      // اگر گزینه withPath روشن بود و فیلد مسیری داشت (مثلا user.name)
      if (withPath && issue.path.length > 0) {
        return `${issue.path.join(".")}: ${message}`;
      }

      return message;
    })
    .join(separator);
};
