import { NextResponse } from "next/server";
import connectDB from "@/lib/db";
import Users from "@models/Users";
import redis from "@/lib/redis";
import { loginSchema } from "@/lib/validations";
import { err, ok } from "@/shared";

import { getIpFromHeader, zodErrorToString } from "@util/helper";
import { verifyCaptcha } from "@lib/captcha";
import {
  authIpRateLimiter,
  authNumberRateLimiter,
  captchaRateLimiter,
} from "@lib/rateLimiter";
import { sendOTP } from "@lib/sms";

export async function POST(req: Request) {
  const header = req.headers;
  const ip = getIpFromHeader(header);

  try {
    const body = await req.json();

    // 1. Validate Zod
    const validation = loginSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(err(zodErrorToString(validation.error)), {
        status: 400,
      });
    }

    const {
      phone,
      captchaTokens: { verifyToken, captchaToken },
    } = validation.data;
    try {
      await captchaRateLimiter.consume(ip);
    } catch (error) {
      return NextResponse.json(
        err(
          "تعداد درخواست‌های شما برای کپچا بیش از حد مجاز است. لطفا بعدا تلاش کنید.",
        ),
        { status: 429 },
      );
    }
    // 2. Verify Captcha
    const captchaVerificationResult = await verifyCaptcha(
      captchaToken,
      verifyToken,
      ip,
    );
    console.log(captchaVerificationResult);
    const { ok: isCaptchaValid } = captchaVerificationResult;

    if (!isCaptchaValid) {
      return NextResponse.json(err(captchaVerificationResult.msg), {
        status: 400,
      });
    }

    // // 4. Rate Limiting (Consume)

    //by phone and ip
    try {
      await Promise.all([
        authNumberRateLimiter.consume(phone),
        authIpRateLimiter.consume(ip),
      ]);
    } catch (error) {
      return NextResponse.json(
        err("تعداد درخواست‌های شما بیش از حد مجاز است. لطفا بعدا تلاش کنید."),
        { status: 429 },
      );
    }
    await connectDB();
    const user = await Users.findOne({ phone });
    if (!user) {
      return NextResponse.json(err("کاربری با این شماره یافت نشد"), {
        status: 404,
      });
    }

    // // 6. Send SMS

    const otpRes = await sendOTP(phone);
    if (!otpRes.ok) return NextResponse.json(err(otpRes.msg), { status: 500 });
    await redis.del(`otp:attempts:${phone}`);
    const otp = otpRes.data;
    await redis.setex(`otp:${phone}`, 120, otp);
    return NextResponse.json(ok(null, "کد تایید با موفقیت ارسال شد"), {
      status: 200,
    });
  } catch (error) {
    console.error("Login Error:", error);
    return NextResponse.json(err("خطای داخلی سرور"), {
      status: 500,
    });
  }
}
