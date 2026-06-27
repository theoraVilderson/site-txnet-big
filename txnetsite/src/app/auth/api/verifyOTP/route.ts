import { DOMAIN_NAME, fullPanelDomain } from "@/env";
import Users from "@models/Users";
import { lastRes } from "@/shared";
import { verifyOTP } from "@lib/auth";
import connectDB from "@lib/db";
import logger from "@lib/logger";
import {
  authVerifyIpRateLimiter,
  authVerifyNumberRateLimiter,
} from "@lib/rateLimiter";
import { createToken, UserPayloadWithoutVersion } from "@lib/session";
import { verifyOTPSchema } from "@lib/validations";
import { getIpFromHeader, sendAsRes, zodErrorToString } from "@util/helper";
import { NextResponse } from "next/server";
import redis from "@/lib/redis";

export async function POST(req: Request) {
  NextResponse;
  const header = req.headers;
  const ip = getIpFromHeader(header);

  try {
    const body = await req.json();

    // 1. Validate Zod
    const validation = verifyOTPSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(sendAsRes(null, zodErrorToString(validation.error.message as any)), {
        status: 400,
      });
    }

    const { otp, phone } = validation.data;
    try {
      await Promise.all([
        authVerifyNumberRateLimiter.consume(phone),
        authVerifyIpRateLimiter.consume(ip)
      ]);
    } catch (error) {
      return NextResponse.json(
        sendAsRes(null,"تعداد درخواست‌های شما برای تایید کد بیش از حد مجاز رسیده است لطفا بعدا تلاش کنید"     ),
        { status: 429 }
      );
    }
 

    await connectDB();

    // اول فقط چک کن دیتای ثبت‌نام هست یا نه، نسازش!
    let user = await Users.findOne({ phone });
    let isNewUser = false;
    let pendingName = "";

    if (!user) {
      const pendingSignup = await redis.get(`signup_data:${phone}`);
      if (pendingSignup) {
        pendingName = JSON.parse(pendingSignup).name;
        isNewUser = true;
      } else {
        return NextResponse.json(sendAsRes(null, "کاربر یافت نشد"), { status: 404 });
      }
    }

    // دوم: کد OTP را بررسی کن
    const verifyOTPRes = await verifyOTP(otp, phone);
    if (!verifyOTPRes.ok) {
      return NextResponse.json(sendAsRes(null, verifyOTPRes.msg), { status: 401 });
    }

    // سوم: اگر کد درست بود و یوزر جدید بود، حالا بسازش!
    if (isNewUser) {
        user = await Users.create({ fullName: pendingName, phone }); 
        await redis.del(`signup_data:${phone}`);
    }
    let obj: UserPayloadWithoutVersion = {
      userId: user!._id.toString(), // این بخش اصلاح شود
      permissions: user!.permissions,
      roles: user!.roles,
    };


    const newJWTTokenRes = await createToken(obj);

    if (!newJWTTokenRes.ok) {
      throw new Error(newJWTTokenRes.msg);
    }
    const dashboard = `https://${fullPanelDomain}`;
    const response = NextResponse.json(
      sendAsRes({ redirectTo: dashboard }, "ساخت توکن با موفقیت انجام شد", true)
    );
    response.cookies.set({
      name: "token",
      value: newJWTTokenRes.data!.token!,
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 365, // 👈 یک سال (ثانیه)
      domain: `.${DOMAIN_NAME}`,
    });

    return response;
  } catch (e) {
    logger.error(`failed to create token For user ${e}`);
    return NextResponse.json(sendAsRes(null, "خطا در ساخت توکن برای کاربر"), {
      status: 500,
    });
  }
}
