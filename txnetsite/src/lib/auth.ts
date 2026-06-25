import { NextRequest } from "next/server";
import { verifyToken } from "./session";
import logger from "./logger";
import { lastRes } from "@/shared";
import redis from "@/lib/redis";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { fullAuthDomain } from "@/env";

export async function validteToken(cookies: NextRequest["cookies"]) {
  const token = cookies.get("token")?.value ?? "";

  return await verifyToken(token);
}
export async function verifyOTP(otp: string, phone: string) {
  const otpKey = `otp:${phone}`;
  const attemptKey = `otp:attempts:${phone}`;
  const lockKey = `lock:${phone}`;

  try {
    // 1️⃣ جلوگیری از پردازش همزمان (Locking)
    // اگر در حال پردازش یک درخواست هستیم، درخواست دوم را رد کن
    const lock = await redis.set(lockKey, "1", "EX", 5, "NX");
    if (!lock) return lastRes(null, "کمی صبر کنید...");

    // 2️⃣ خواندن کد و تعداد تلاش‌ها به صورت همزمان
    const [realOTP, attempts] = await Promise.all([
      redis.get(otpKey),
      redis.get(attemptKey),
    ]);

    if (!realOTP) {
      return lastRes(null, "کد منقضی شده ");
    }

    // 3️⃣ چک کردن تعداد تلاش‌های مجاز (مثلا ۵ بار)
    if (parseInt(attempts || "0") >= 5) {
      await redis.del(otpKey, attemptKey); // کد را بسوزان
      return lastRes(null, "بیش از حد تلاش کردید. کد جدید دریافت کنید");
    }

    // 4️⃣ بررسی صحت کد
    if (realOTP !== otp) {
      // کد غلط بود -> یکی به تعداد تلاش‌ها اضافه کن
      await redis.incr(attemptKey);
      // برای بار اول، زمان انقضای شمارنده را هم‌اندازه با کد اصلی بگذار
      if (!attempts) await redis.expire(attemptKey, await redis.ttl(otpKey));

      return lastRes(null, "کد وارد شده اشتباه است");
    }

    // ✅ ۵️⃣ موفقیت: پاکسازی و خروج
    await redis.del(otpKey, attemptKey, lockKey);
    return lastRes(null, "تایید شد", true);
  } catch (e) {
    logger.error(`Error: ${e}`);
    return lastRes(null, "خطای سیستمی");
  } finally {
    // همیشه قفل را آزاد کن (اگر قبلا توسط موفقیت پاک نشده بود)
    await redis.del(lockKey);
  }
}

export async function getValidatedUser() {
  // 3. اعتبارسنجی توکن
  const validateTokenResult = await validteToken(
    (await cookies()) as unknown as NextRequest["cookies"]
  );
  const { failed: failedToken, data: userTokenData } = validateTokenResult;
  if (failedToken) {
    return null;
  }
  return userTokenData;
}
