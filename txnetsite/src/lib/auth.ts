import { NextRequest } from "next/server";
import { verifyToken } from "./session";
import logger from "./logger";
import redis from "@/lib/redis";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { fullAuthDomain } from "@/env";
import { err, ok } from "@/shared";

export async function validteToken(cookies: NextRequest["cookies"]) {
  const token = cookies.get("token")?.value ?? "";

  return await verifyToken(token);
}
export async function verifyOTP(otp: string, phone: string) {
  const otpKey = `otp:${phone}`;
  const attemptKey = `otp:attempts:${phone}`;
  const lockKey = `lock:${phone}`;

  // متغیری برای اینکه بدانیم آیا این درخواست خاص، قفل را گرفته یا نه
  let lockAcquired = false;

  try {
    // 1️⃣ تلاش برای گرفتن قفل
    const lock = await redis.set(lockKey, "1", "EX", 5, "NX");
    if (!lock) {
      return err("کمی صبر کنید...");
    }
    lockAcquired = true; // این درخواست صاحب قفل است

    // 2️⃣ خواندن کد اصلی از ردیس
    const realOTP = await redis.get(otpKey);
    if (!realOTP) {
      return err("کد منقضی شده یا نامعتبر است");
    }

    // 3️⃣ افزایش تعداد تلاش‌ها (عملیات اتمیک و امن)
    // به جای اینکه اول بخوانیم و بعد اضافه کنیم، همین الان اضافه می‌کنیم
    const currentAttempts = await redis.incr(attemptKey);

    // اگر اولین بار است که اشتباه/تلاش ثبت می‌شود، برایش تاریخ انقضا می‌گذاریم
    if (currentAttempts === 1) {
      const ttl = await redis.ttl(otpKey);
      if (ttl > 0) {
        await redis.expire(attemptKey, ttl);
      } else {
        await redis.expire(attemptKey, 120); // یک مقدار پیش‌فرض اگر TTL مشکلی داشت
      }
    }

    // 4️⃣ چک کردن سقف مجاز تلاش‌ها
    if (currentAttempts > 5) {
      await redis.del(otpKey, attemptKey); // کد را بسوزان
      return err("بیش از حد تلاش کردید. کد جدید دریافت کنید");
    }

    // 5️⃣ بررسی صحت کد
    if (realOTP !== otp) {
      // تعداد تلاش‌ها در مرحله ۳ افزایش یافته، فقط پیام خطا می‌دهیم
      return err("کد وارد شده اشتباه است");
    }

    // ✅ ۶️⃣ موفقیت: پاکسازی و خروج
    await redis.del(otpKey, attemptKey);
    return ok("تایید شد");
  } catch (e) {
    logger.error(`Error: ${e}`);
    return err("خطای سیستمی");
  } finally {
    // 🔴 فقط در صورتی قفل را باز کن که همین درخواست آن را ساخته باشد
    if (lockAcquired) {
      await redis.del(lockKey);
    }
  }
}
export async function getValidatedUser() {
  // 3. اعتبارسنجی توکن
  const validateTokenResult = await validteToken(
    (await cookies()) as unknown as NextRequest["cookies"],
  );
  const { failed: failedToken, data: userTokenData } = validateTokenResult;
  if (failedToken) {
    return null;
  }
  return userTokenData;
}
