// lib/rateLimiter.ts
import { RateLimiterRedis } from "rate-limiter-flexible";
import redisClient from "@lib/redis";
import { isDev } from "@/env";
// اتصال به ردیس (از همان کانتینر ردیس داکر)

// تنظیمات کلی لیمیت
// مثلا: هر آی‌پی اجازه دارد ۱۰ درخواست در هر ثانیه بفرستد
export const rateLimiter = new RateLimiterRedis({
  storeClient: redisClient,
  keyPrefix: "middleware_limit",
  points: 115, // تعداد مجاز درخواست
  duration: 2, // در بازه زمانی (ثانیه)
});

// تنظیمات خاص برای لاگین (سخت‌گیرانه‌تر)
// مثلا: ۵ تلاش در هر 60 دقیقه
export const authNumberRateLimiter = new RateLimiterRedis({
  storeClient: redisClient,
  keyPrefix: "auth_limit_number",
  points: 5,
  duration: 60 * 2,
});
export const authIpRateLimiter = new RateLimiterRedis({
  storeClient: redisClient,
  keyPrefix: "auth_limit_ip",
  points: 5,
  duration: 60 * 2,
});
// مثلا: ۵ تلاش در هر ۱۵ دقیقه
export const captchaRateLimiter = new RateLimiterRedis({
  storeClient: redisClient,
  keyPrefix: "captcha_limit",
  points: 10,
  duration: 60 * 2, // 15 دقیقه به ثانیه
});

// مثلا: ۵ تلاش در هر 60 دقیقه
export const authVerifyNumberRateLimiter = new RateLimiterRedis({
  storeClient: redisClient,
  keyPrefix: "authVerify_limit_number",
  points: 3,
  duration: 60 * 2,
});
export const authVerifyIpRateLimiter = new RateLimiterRedis({
  storeClient: redisClient,
  keyPrefix: "authVerify_limit_ip",
  points: 3,
  duration: 60 * 2,
});
