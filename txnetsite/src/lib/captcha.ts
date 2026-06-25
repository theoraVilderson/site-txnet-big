import { lastRes } from "@/shared";
import logger from "./logger";
import { JWK, JWTPayload, jwtVerify, SignJWT } from "jose";
import { v4 as uuidv4 } from "uuid";
import { JWT_SECRET_CAPTCHA } from "@/env";
import { UserPayload } from "./session";
import { KeyObject } from "crypto";
import { generateJIT } from "@util/helper";
import CryptoJS from "crypto-js";

export const JWT_SECRET_CAPTCHA_ENCODED = new TextEncoder().encode(
  JWT_SECRET_CAPTCHA || "your-super-chan2232ge-key"
);
export function captchaDecyptor(encryptedText: string, key: string) {
  try {
    const bytes = CryptoJS.AES.decrypt(encryptedText, key);
    const originalText = bytes.toString(CryptoJS.enc.Utf8);

    if (!originalText) return lastRes(null, "خطا در بازگشیایی کپچا");
    const { jti, ip, ...other } = JSON.parse(originalText);
    return lastRes({ jti, ip }, "بازگشایی کپچا موفق", true);
  } catch (e) {
    logger.error("Error: Invalid Data", e);
    return lastRes(null, "خطا در بازگشیایی کپچا");
  }
}
export interface CaptchaPayload extends JWTPayload {
  ip: string;
}
export function decryptAndVerifyCaptcha(
  encryptedText: string,
  key: string,
  { ip, jti }: { ip: string; jti: string }
) {
  try {
    const result = captchaDecyptor(encryptedText, key);
    const { failed, data } = result;
    if (failed) {
      return result;
    }
    if (data?.ip !== ip) {
      logger.warn("captcha verify token ip is not same as sender!");
      return lastRes(null, "کپچا نامعتبر");
    }
    if (data?.jti !== jti) {
      logger.warn(
        "captcha invalid token jti is not same as sender captchaToken!"
      );
      return lastRes(null, "کپچا نامعتبر");
    }

    return lastRes(data, "توکن کپچا معتبر است", true);
  } catch (e) {
    logger.error("failed to decrypt captcha", e);
    return lastRes(null, "خطا در  بررسی توکن کپچا");
  }
}

export async function validateCaptcha(
  captchaToken: string,
  verifyToken: string,
  ip: string
) {
  // decode captchaToken

  try {
    // الف: بررسی اعتبار امضا و تاریخ انقضا توسط کتابخانه jose
    const { payload } = await jwtVerify(
      captchaToken,
      JWT_SECRET_CAPTCHA_ENCODED
    );

    // اطمینان از اینکه پیلود با تایپ ما سازگار است
    const captchaPayload = payload as CaptchaPayload;

    // ب: بررسی اینکه آیا JTI در بلاک‌لیست هست یا نه
    if (captchaPayload.jti) {
      // کلید در ردیس به صورت nextjs-app-v1:blocked_jti:... ذخیره می‌شود (به خاطر prefix)
      const isBlocked = await redis.get(`blocked_jti:${captchaPayload.jti}`);

      if (isBlocked) {
        logger.warn(`Token blocked: ${captchaPayload.jti}`);
        return lastRes(null, "توکن  کپچا نامعبر"); // توکن بلاک شده است
      }
    }
    // check if sender ip is the same with captcha Token and Verify token
    if (captchaPayload.ip !== ip) {
      logger.warn("captcha  token ip is not same as sender!");
      return lastRes(null, "کپچا نامعتبر");
    }
    // check if captchaToken is exists in redis
    const captchaInfo = await redis.get(
      `captchaToken:${ip}-${captchaPayload.jti}`
    );

    if (!captchaInfo) {
      logger.warn(`Token is not exists in redis: `);
      return lastRes<null>(null, "توکن نامعبر"); // توکن بلاک شده است
    }

    // decode verifytoken
    const decryptResult = decryptAndVerifyCaptcha(verifyToken, captchaToken, {
      ip,
      jti: captchaPayload.jti!,
    });
    const { failed } = decryptResult;
    if (failed) {
      return decryptResult;
    }

    return lastRes<CaptchaPayload>(captchaPayload, "توکن معتبر است", true); // توکن معتبر است
  } catch (error) {
    // خطاهایی مثل انقضای توکن یا دستکاری امضا اینجا میفتند
    logger.error("JWT Verification failed:", error);
    return lastRes(null, "توکن نامعبر"); // توکن بلاک شده است
  }

  // check if both jti is the same
}
export async function verifyCaptcha(
  ...args: Parameters<typeof validateCaptcha>
) {
  const captchaResult = await validateCaptcha(...args);
  const { failed, data } = captchaResult;
  if (failed) {
    return captchaResult;
  }
  const d = data as CaptchaPayload;
  await redis.del("captchaToken:" + d.ip + "-" + d.jti);
  return captchaResult;
}
const CAPTCHA_EXPIRE_TIME = 2 * 60;
async function generateCatpchaToken(payload: CaptchaPayload) {
  return generateJIT<CaptchaPayload>(payload, JWT_SECRET_CAPTCHA_ENCODED, "2m");
}
export async function createCaptchaToken(payload: CaptchaPayload) {
  try {
    const genereatedCaptchaToken = await generateCatpchaToken(payload);
    // ذخیره در ردیس با Expiration
    await redis.set(
      `captchaToken:${payload.ip + "-" + genereatedCaptchaToken.jti}`, // نام کلید
      "cpt", // مقدار (مهم نیست)
      "EX", // واحد زمان (ثانیه)
      CAPTCHA_EXPIRE_TIME // مدت زمان (۱ سال)
    );

    return lastRes(genereatedCaptchaToken, "توکن سشن با موفقت ساتخته شد", true);
  } catch (error) {
    logger.error("Error revoking token:", error);
    return lastRes(null, "خطا در ساخت سشن توکن ");
  }
}
