import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import connectDB from "@/lib/db";
import Users from "@/models/Users";
import { sendAsRes } from "@util/helper";
import { getValidatedUser } from "@lib/auth";
import { AllServiceTypes } from "@/configs/services";
import { CouponService } from "@lib/payment/coupon/couponService";
import { couponCheckSchema } from "@lib/validations";

export async function POST(req: NextRequest) {
  try {
    // 2. احراز هویت کاربر
    const validatedUser = await getValidatedUser();
    if (!validatedUser) {
      return NextResponse.json(
        sendAsRes(null, "لطفا ابتدا وارد حساب کاربری شوید", false),
        { status: 401 }
      );
    }

    await connectDB();
    const body = await req.json();

    // 3. اعتبارسنجی داده‌های ورودی
    const validation = couponCheckSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(sendAsRes(null, validation.error.message), {
        status: 400,
      });
    }

    const { amount, couponsCode } = validation.data;
    const userId = validatedUser.userId;

    // تبدیل واحد: مبلغ ورودی تومان است، سیستم محاسباتی شما (طبق کد قبلی) ریال کار می‌کند
    const baseAmountInRial = amount;

    // 4. فراخوانی سرویس محاسبه کوپن (بدون ثبت تراکنش)
    // فرض بر این است که این سرویس فقط محاسبه می‌کند و چیزی در دیتابیس تغییر نمی‌دهد
    const couponResult = await CouponService.validateCoupons(
      couponsCode,
      baseAmountInRial,
      userId,
      AllServiceTypes.WALLET // نوع سرویس (شارژ کیف پول)
    );

    // 5. بررسی نتیجه اعتبارسنجی
    if (!couponResult.isValid || couponResult.errors.length > 0) {
      const errorMsg = couponResult.errors.join(" | ");
      return NextResponse.json(
        sendAsRes(null, errorMsg || "کد تخفیف نامعتبر است", false),
        { status: 400 }
      );
    }

    // 6. آماده‌سازی خروجی برای فرانت‌اند
    // مقادیر را به تومان برمی‌گردانیم تا نمایش راحت‌تر باشد (اختیاری)
    const responseData = {
      ...couponResult,
      originalAmount: amount, // مبلغ اولیه (تومان)
    };

    return NextResponse.json(
      sendAsRes(responseData, "کد تخفیف با موفقیت اعمال شد", true)
    );
  } catch (error: any) {
    console.error("Coupon Validation Error:", error);
    return NextResponse.json(
      sendAsRes(null, "خطای سیستمی در بررسی کد تخفیف", false),
      { status: 500 }
    );
  }
}
