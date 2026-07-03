import { NextResponse } from "next/server";
import connectDB from "@/lib/db";
import Users from "@models/Users";
import redis from "@/lib/redis";
import { signupSchema } from "@/lib/validations";
import { verifyCaptcha } from "@lib/captcha";
import { generateOTP, sendOTP, sendSMS } from "@lib/sms";
import {
  authIpRateLimiter,
  authNumberRateLimiter,
  captchaRateLimiter,
} from "@lib/rateLimiter";
import { getIpFromHeader, zodErrorToString } from "@util/helper";
import { err, ok } from "@/shared";
// {
//   verifyCaptcha,
//   // ,
//   generateOTP,
//   sendSMS,
// }

export async function POST(req: Request) {
  const header = req.headers;
  const ip = getIpFromHeader(header);
  try {
    const body = await req.json();

    // 1. Validate Zod
    const validation = signupSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(err(zodErrorToString(validation.error)), {
        status: 400,
      });
    }
    const {
      phone,
      name,
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
    const captchaVerificationResult = await verifyCaptcha(
      captchaToken,
      verifyToken,
      ip,
    );

    if (!captchaVerificationResult.ok) {
      return NextResponse.json(captchaVerificationResult, {
        status: 400,
      });
    }
    await connectDB();

    // 3. Check User Duplication
    const existingUser = await Users.findOne({ phone }).lean();
    if (existingUser) {
      // اگر کاربر وجود دارد ولی وریفای نشده، شاید بخواهید کد را دوباره بفرستید
      // اما طبق درخواست شما اگر کاربر باشد باید خطا بدهیم:
      return NextResponse.json(
        { error: "این شماره قبلاً ثبت شده است" },
        { status: 409 },
      );
    }

    // 4. Rate Limiting (Consume)
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

    const sendOTPRes = await sendOTP(phone);
    if (!sendOTPRes.ok) return NextResponse.json(sendOTPRes, { status: 500 });
    // ✅ اطلاعات ثبت‌نام را به صورت موقت در ردیس ذخیره کنید
    const signupData = JSON.stringify({ name, isSignup: true });
    const otp = sendOTPRes.data;
    await redis.del(`otp:attempts:${phone}`);
    await redis.setex(`otp:${phone}`, 120, otp);
    await redis.setex(`signup_data:${phone}`, 120, signupData); // کش کردن دیتای کاربر

    return NextResponse.json(ok(null,"کد تایید با موفقیت ارسال شد"), {
      status: 200,
    });
  } catch (error) {
    console.error("Login Error:", error);
    return NextResponse.json(err("خطای داخلی سرور"), {
      status: 500,
    });
  }
}
