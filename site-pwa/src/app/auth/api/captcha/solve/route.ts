import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";
import CryptoJS from "crypto-js";
import { JWT_SECRET_CAPTCHA_ENCODED } from "@/lib/captcha";
import { getIpFromHeader } from "@/util/helper";
import { err, ok } from "@/shared";

export async function POST(req: NextRequest) {
  try {
    const { captchaToken, dragTime } = await req.json();
    const ip = getIpFromHeader(req.headers);

    // ۱. آنتی‌ربات رفتاری: اسلایدر نباید زیر ۲۰۰ میلی‌ثانیه یا بالای ۱۰ ثانیه کشیده شود
    if (!dragTime || dragTime < 200 || dragTime > 10000) {
      return NextResponse.json(err("رفتار مشکوک به ربات"), { status: 400 });
    }

    // ۲. بررسی اعتبار خود توکن کپچا
    const { payload } = await jwtVerify(
      captchaToken,
      JWT_SECRET_CAPTCHA_ENCODED,
    );

    if (payload.ip !== ip) {
      return NextResponse.json(err("IP نامعتبر است"), { status: 400 });
    }

    // ۳. تولید verifyToken در محیط امن سرور! (دقیقاً مشابه منطق قبلی شما)
    const verifyPayload = JSON.stringify({
      ip: payload.ip,
      jti: payload.jti,
    });

    const verifyToken = CryptoJS.AES.encrypt(
      verifyPayload,
      captchaToken,
    ).toString();

    return NextResponse.json(ok({ verifyToken }, "کپچا حل شد"));
  } catch (error) {
    return NextResponse.json(err("کپچا نامعتبر است"), {
      status: 400,
    });
  }
}
