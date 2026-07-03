import logger from "./logger";
import { JWK, JWTPayload, jwtVerify, SignJWT } from "jose";
import { v4 as uuidv4 } from "uuid";
import { JWT_SECRET_CAPTCHA } from "@/env";
import { UserPayload } from "./session";
import { KeyObject } from "crypto";
import { generateJIT } from "@util/helper";
import CryptoJS from "crypto-js";
import { err, ok } from "@/shared";

export const JWT_SECRET_CAPTCHA_ENCODED = new TextEncoder().encode(
  JWT_SECRET_CAPTCHA || "your-super-chan2232ge-key",
);
export function captchaDecyptor(encryptedText: string, key: string) {
  try {
    const bytes = CryptoJS.AES.decrypt(encryptedText, key);
    const originalText = bytes.toString(CryptoJS.enc.Utf8);

    if (!originalText) return err("خطا در بازگشیایی کپچا");
    const { jti, ip, ...other } = JSON.parse(originalText);
    return ok({ jti, ip }, "بازگشایی کپچا موفق");
  } catch (e) {
    logger.error("Error: Invalid Data", e);
    return err("خطا در بازگشیایی کپچا");
  }
}
export interface CaptchaPayload extends JWTPayload {
  ip: string;
}
export function decryptAndVerifyCaptcha(
  encryptedText: string,
  key: string,
  { ip, jti }: { ip: string; jti: string },
) {
  try {
    const result = captchaDecyptor(encryptedText, key);
    if (!result.ok) {
      return result;
    }
    const { data } = result;
    if (data?.ip !== ip) {
      logger.warn("captcha verify token ip is not same as sender!");
      return err("کپچا نامعتبر");
    }
    if (data?.jti !== jti) {
      logger.warn(
        "captcha invalid token jti is not same as sender captchaToken!",
      );
      return err("کپچا نامعتبر");
    }

    return ok(data, "توکن کپچا معتبر است");
  } catch (e) {
    logger.error("failed to decrypt captcha", e);
    return err("خطا در  بررسی توکن کپچا");
  }
}

export async function validateCaptcha(
  captchaToken: string,
  verifyToken: string,
  ip: string,
) {
  // decode captchaToken

  try {
    // الف: بررسی اعتبار امضا و تاریخ انقضا توسط کتابخانه jose
    const { payload } = await jwtVerify(
      captchaToken,
      JWT_SECRET_CAPTCHA_ENCODED,
    );

    // اطمینان از اینکه پیلود با تایپ ما سازگار است
    const captchaPayload = payload as CaptchaPayload;

    // ب: بررسی اینکه آیا JTI در بلاک‌لیست هست یا نه
    if (captchaPayload.jti) {
      // کلید در ردیس به صورت nextjs-app-v1:blocked_jti:... ذخیره می‌شود (به خاطر prefix)
      const isBlocked = await redis.get(`blocked_jti:${captchaPayload.jti}`);

      if (isBlocked) {
        logger.warn(`Token blocked: ${captchaPayload.jti}`);
        return err("توکن  کپچا نامعبر"); // توکن بلاک شده است
      }
    }
    // check if sender ip is the same with captcha Token and Verify token
    if (captchaPayload.ip !== ip) {
      logger.warn("captcha  token ip is not same as sender!");
      return err("کپچا نامعتبر");
    }
    // check if captchaToken is exists in redis
    const captchaInfo = await redis.get(
      `captchaToken:${ip}-${captchaPayload.jti}`,
    );

    if (!captchaInfo) {
      logger.warn(`Token is not exists in redis: `);
      return err("توکن نامعبر"); // توکن بلاک شده است
    }

    // decode verifytoken
    const decryptResult = decryptAndVerifyCaptcha(verifyToken, captchaToken, {
      ip,
      jti: captchaPayload.jti!,
    });
    if (!decryptResult.ok) {
      return decryptResult;
    }

    return ok(captchaPayload, "توکن معتبر است"); // توکن معتبر است
  } catch (error) {
    // خطاهایی مثل انقضای توکن یا دستکاری امضا اینجا میفتند
    logger.error("JWT Verification failed:", error);
    return err("توکن نامعبر"); // توکن بلاک شده است
  }

  // check if both jti is the same
}
export async function verifyCaptcha(
  ...args: Parameters<typeof validateCaptcha>
) {
  const captchaResult = await validateCaptcha(...args);
  if (!captchaResult.ok) {
    return captchaResult;
  }
  const d = captchaResult.data;
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
      CAPTCHA_EXPIRE_TIME, // مدت زمان (۱ سال)
    );

    return ok(genereatedCaptchaToken, "توکن سشن با موفقت ساتخته شد");
  } catch (error) {
    logger.error("Error revoking token:", error);
    return err("خطا در ساخت سشن توکن ");
  }
}
