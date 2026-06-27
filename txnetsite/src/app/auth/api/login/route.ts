import { NextResponse } from "next/server";
import connectDB from "@/lib/db";
import Users from "@models/Users";
import redis from "@/lib/redis";
import { loginSchema } from "@/lib/validations";

import { getIpFromHeader, sendAsRes } from "@util/helper";
import { verifyCaptcha } from "@lib/captcha";
import { sendRes } from "@/shared";
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
      return NextResponse.json(sendAsRes(null, validation.error.message), {
        status: 400,
      });
    }
    await captchaRateLimiter.consume(ip);

    const {
      phone,
      captchaTokens: { verifyToken, captchaToken },
    } = validation.data;
    // 2. Verify Captcha
    const captchaVerificationResult = await verifyCaptcha(
      captchaToken,
      verifyToken,
      ip
    );
    console.log(captchaVerificationResult);
    const { ok: isCaptchaValid, data } = captchaVerificationResult;

    if (!isCaptchaValid) {
      return NextResponse.json(
        sendRes<typeof data>(captchaVerificationResult),
        {
          status: 400,
        }
      );
    }

    // // 4. Rate Limiting (Consume)

    //by phone and ip
    try {
      await Promise.all([
        authNumberRateLimiter.consume(phone),
        authIpRateLimiter.consume(ip)
      ]);
    } catch (error) {
      return NextResponse.json(
        sendAsRes(null, "تعداد درخواست‌های شما بیش از حد مجاز است. لطفا بعدا تلاش کنید."),
        { status: 429 }
      );
    }
    await connectDB();
    const user = await Users.findOne({ phone });
    if (!user) {
      return NextResponse.json(
        sendAsRes(null, "کاربری با این شماره یافت نشد"),
        { status: 404 }
      );
    }

    // // 6. Send SMS

    const { ok, msg, data: otp } = await sendOTP(phone);
    if (!ok) return NextResponse.json(sendAsRes(null, msg), { status: 500 });
    await redis.setex(`otp:${phone}`, 120, otp!);

    return NextResponse.json({ message: "کد تایید ارسال شد" }, { status: 200 });
  } catch (error) {
    console.error("Login Error:", error);
    return NextResponse.json({ error: "خطای داخلی سرور" }, { status: 500 });
  }
}
