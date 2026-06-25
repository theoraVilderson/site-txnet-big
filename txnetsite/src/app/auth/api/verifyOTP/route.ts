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
import { getIpFromHeader, sendAsRes } from "@util/helper";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  NextResponse;
  const header = req.headers;
  const ip = getIpFromHeader(header);

  try {
    const body = await req.json();

    // 1. Validate Zod
    const validation = verifyOTPSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(sendAsRes(null, validation.error.message), {
        status: 400,
      });
    }

    const { otp, phone } = validation.data;

    try {
      await authVerifyNumberRateLimiter.consume(phone);
    } catch (error) {
      return NextResponse.json(
        sendAsRes(
          null,
          "تعداد درخواست‌های شما برای تایید کد بیش از حد مجاز رسیده است لطفا بعدا تلاش کنید"
        ),

        { status: 429 }
      );
    }

    try {
      await authVerifyIpRateLimiter.consume(ip);
    } catch (error) {
      return NextResponse.json(
        sendAsRes(
          null,
          "تعداد درخواست‌های شما برای تایید کد بیش از حد مجاز رسیده است لطفا بعدا تلاش کنید"
        ),

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
    const verifyOTPRes = await verifyOTP(otp, phone);
    if (!verifyOTPRes.ok) {
      return NextResponse.json(sendAsRes(null, verifyOTPRes.msg), {
        status: 401,
      });
    }
    let obj: UserPayloadWithoutVersion = {
      userId: user._id,
      permissions: user.permissions,
      roles: user.roles,
    };

    obj = JSON.parse(JSON.stringify(obj));

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
