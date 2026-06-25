import { SignJWT, jwtVerify, JWTPayload } from "jose";
import { v4 as uuidv4 } from "uuid";
import redis from "./redis";
import logger from "./logger";
import { JWT_SECRET } from "@/env";
import { addTimeFromNow, lastRes } from "@/shared";
import { generateJIT } from "@util/helper";

// کلید مخفی (حتما در فایل .env قرار دهید)
const JWT_SECRET_ENCODED = new TextEncoder().encode(
  JWT_SECRET || "your-super-chan2232ge-key"
);
const ONE_YEAR_IN_SECONDS = 365 * 24 * 60 * 60;

// تعریف اینترفیس برای پیلود توکن شما
export interface UserPayloadType extends JWTPayload {
  userId: string;
  roles: string[];
  permissions: string[];
  version: number;
}

export interface UserPayload extends JWTPayload {}

export type UserPayloadWithoutVersion = Omit<UserPayloadType, "version">;

/**
 * 1. ساخت توکن (Sign)
 * همراه با تولید JTI یکتا
 */
export async function generateSessionToken(payload: UserPayload) {
  return generateJIT<UserPayload>(
    payload,
    JWT_SECRET_ENCODED,
    addTimeFromNow(ONE_YEAR_IN_SECONDS)
  );
}
export async function createToken(payload: UserPayloadWithoutVersion) {
  try {
    const tokenVersion = await redis.get(
      `session_update_token:${payload.userId}`
    );
    const lastTokenVersion = tokenVersion ? Number(tokenVersion) : 1;
    const newPayload: UserPayload = { ...payload, version: lastTokenVersion };

    const genereatedSessionToken = await generateSessionToken(newPayload);

    return lastRes(genereatedSessionToken, "توکن سشن با موفقت ساتخته شد", true);
  } catch (error) {
    logger.error("Error revoking token:", error);
    return lastRes(null, "خطا در ساخت سشن توکن ");
  }
}

/**
 * 2. وریفای کردن توکن
 * بررسی امضا + بررسی لیست سیاه در ردیس
 */
export async function verifyToken(token: string) {
  try {
    // الف: بررسی اعتبار امضا و تاریخ انقضا توسط کتابخانه jose
    const { payload } = await jwtVerify(token, JWT_SECRET_ENCODED);

    // اطمینان از اینکه پیلود با تایپ ما سازگار است
    const userPayload = payload as UserPayloadType;

    // ب: بررسی اینکه آیا JTI در بلاک‌لیست هست یا نه
    if (userPayload.jti) {
      // کلید در ردیس به صورت nextjs-app-v1:blocked_jti:... ذخیره می‌شود (به خاطر prefix)
      const isBlocked = await redis.get(`blocked_jti:${userPayload.jti}`);

      if (isBlocked) {
        logger.warn(`Token blocked: ${userPayload.jti}`);
        return lastRes<null>(null, "توکن نامعبر"); // توکن بلاک شده است
      }
    }
    // check if token version is valid
    const tokenVersion = await redis.get(
      `session_update_token:${userPayload.userId}`
    );

    if (tokenVersion != null) {
      const isTokenVersionIsUpdate =
        Number(tokenVersion) == userPayload.version;
      if (!isTokenVersionIsUpdate) {
        logger.warn(`Token version dosn't match: ${userPayload.jti}`);
        return lastRes<null>(null, "توکن نامعبر"); // توکن بلاک شده است
      }
    }
    return lastRes<UserPayloadType>(userPayload, "توکن معتبر است", true); // توکن معتبر است
  } catch (error) {
    // خطاهایی مثل انقضای توکن یا دستکاری امضا اینجا میفتند
    // logger.error("JWT Verification failed:", error);
    return lastRes<null>(null, "توکن نامعبر"); // توکن بلاک شده است
  }
}

/**
 * 3. بلاک کردن توکن (Logout)
 * JTI را استخراج کرده و برای یک سال در ردیس نگه می‌دارد
 */
export async function revokeToken(token: string): Promise<boolean> {
  try {
    // توکن را باز می‌کنیم تا JTI را بخوانیم
    // از jwtVerify استفاده می‌کنیم تا مطمئن شویم توکن فرمت درستی دارد
    // حتی اگر Expire شده باشد شاید بخواهیم ارور را نادیده بگیریم و JTI را برداریم
    // اما برای امنیت بیشتر، فقط توکن‌های معتبر را بلاک می‌کنیم
    const { payload } = await jwtVerify(token, JWT_SECRET_ENCODED);

    if (payload.jti) {
      // ذخیره در ردیس با Expiration
      await redis.set(
        `blocked_jti:${payload.jti}`, // نام کلید
        "blocked", // مقدار (مهم نیست)
        "EX", // واحد زمان (ثانیه)
        ONE_YEAR_IN_SECONDS // مدت زمان (۱ سال)
      );
      return true;
    }
  } catch (error) {
    logger.error("Error revoking token:", error);
  }
  return false;
}
