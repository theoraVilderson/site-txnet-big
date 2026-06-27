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
import { getIpFromHeader, sendAsRes, zodErrorToString } from "@util/helper";
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
      return NextResponse.json(
        sendAsRes(null, zodErrorToString(validation.error)),
        { status: 400 }
      );
    }
    const {
      phone,
      name,
      captchaTokens: { verifyToken, captchaToken },
    } = validation.data;

    try{
      await captchaRateLimiter.consume(ip);
    } catch (error) {
      return NextResponse.json(
        sendAsRes(null, "تعداد درخواست‌های شما برای کپچا بیش از حد مجاز است. لطفا بعدا تلاش کنید."),
        { status: 429 }
      );
    }
    const captchaVerificationResult = await verifyCaptcha(
      captchaToken,
      verifyToken,
      ip
    );
    const {
      ok: isCaptchaValid,
      data,
      msg: captchaMsg,
    } = captchaVerificationResult;

    if (!isCaptchaValid) {
      return NextResponse.json(sendAsRes(null, captchaMsg), {
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
        { status: 409 }
      );
    }

    // 4. Rate Limiting (Consume)
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

    

    const { ok, msg, data: otp } = await sendOTP(phone);
    if (!ok) return NextResponse.json(sendAsRes(null, msg), { status: 500 });
// ✅ اطلاعات ثبت‌نام را به صورت موقت در ردیس ذخیره کنید
  const signupData = JSON.stringify({ name, isSignup: true });
  await redis.setex(`otp:${phone}`, 120, otp!);
  await redis.setex(`signup_data:${phone}`, 120, signupData); // کش کردن دیتای کاربر

  return NextResponse.json(
    sendAsRes(null, "کد تایید با موفقیت ارسال شد", true), 
    { status: 200 }
  );
} catch (error) {
  console.error("Login Error:", error);
  return NextResponse.json(
    sendAsRes(null, "خطای داخلی سرور" ), 
    { status: 500 }
  );
}
}
