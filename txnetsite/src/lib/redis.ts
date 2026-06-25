// lib/redis.js
import { isProd, REDIS_PASSWORD, REDIS_PORT } from "@/env";
import Redis, { RedisOptions } from "ioredis";

const REDIS_URL = `redis://:${REDIS_PASSWORD}@redis:${REDIS_PORT}/`;

// تنظیمات ایزولاسیون:
// با استفاده از keyPrefix، تمام کلیدهای این برنامه به صورت خودکار
// با پیشوند "nextjs-app:" ذخیره می‌شوند.
// مثلا اگر کلیدی به نام "blocked:123" بسازید، در ردیس "nextjs-app:blocked:123" ذخیره می‌شود.
// اینگونه با سرویس‌های دیگر تداخل نخواهد داشت.
const redisOptions: RedisOptions = {
  keyPrefix: "txnetsite:",
};

let redis: Redis;
if (!global.redis) {
  global.redis = new Redis(REDIS_URL, redisOptions);
}
redis = global.redis;

export default redis;
