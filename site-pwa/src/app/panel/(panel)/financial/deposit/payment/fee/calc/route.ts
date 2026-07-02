// pages/api/deposit/payment/fee.ts (یا مسیر کنترلر شما)
import { NextApiRequest, NextApiResponse } from "next";
// مسیر مدل شما
import { PaymentFeeParams } from "@/types/payment"; // اینترفیس‌ها
import PaymentSettings from "@models/PaymentSettings";
import {
  FeeCurrency,
  FeeMode,
  FeeType,
  PaymentProvider,
} from "@/configs/paymentSettings";
import { PaymentFactory } from "@lib/payment/gateway/paymentFactory";
import { zodErrorToString } from "@util/helper";
import logger from "@lib/logger";
import { NextRequest, NextResponse } from "next/server";
import { getValidatedUser } from "@lib/auth";
import connectDB from "@lib/db";
import { feeCalcSchema } from "@lib/validations";
import { PaymentCurrency } from "@/configs/payments";
import { err, ok } from "@/shared";

export async function POST(req: NextRequest) {
  try {
    // 2. احراز هویت کاربر
    const validatedUser = await getValidatedUser();
    if (!validatedUser) {
      return NextResponse.json(err("لطفا ابتدا وارد حساب کاربری شوید"), {
        status: 401,
      });
    }

    await connectDB();
    const body = await req.json();

    // 3. اعتبارسنجی داده‌های ورودی
    const validation = feeCalcSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(err(zodErrorToString(validation.error)), {
        status: 400,
      });
    }

    const { amount, gatewayName } = validation.data;

    // 1. دریافت تنظیمات درگاه
    const settings = await PaymentSettings.findOne({
      gatewayName,
      isActive: true,
    });

    if (!settings) {
      return NextResponse.json(err("درگاه یافت نشد"), {
        status: 404,
      });
    }

    let calculatedFee = 0;

    const providerName = gatewayName as PaymentProvider;

    // فراخوانی فکتوری طبق درخواست شما
    const paymentStrategy = await PaymentFactory.getProvider(providerName);

    const feeParams: PaymentFeeParams = {
      amount: amount, // مبلغ به تومان
      currency: PaymentCurrency.IRR, // فرض بر تومان بودن سیستم
    };

    // دریافت کارمزد از سرویس‌دهنده
    const feeCalcResult = await paymentStrategy.feeCalculation!(feeParams);
    if (!feeCalcResult.ok) throw feeCalcResult.msg;
    // feeResult باید عدد باشد
    calculatedFee = feeCalcResult.data.feeAmount;

    // اعمال محدودیت‌های minLimit و maxLimit اگر وجود داشت
    if (
      settings.feeConfig.minLimit &&
      calculatedFee < settings.feeConfig.minLimit
    ) {
      calculatedFee = settings.feeConfig.minLimit;
    }
    if (
      settings.feeConfig.maxLimit &&
      calculatedFee > settings.feeConfig.maxLimit
    ) {
      calculatedFee = settings.feeConfig.maxLimit;
    }
    return NextResponse.json(
      ok({ feeAmount: Math.floor(calculatedFee) }, " محاسبه کارمزد"),
    );
  } catch (error) {
    logger.error(`Fee Calculation Error: ${error}`);
    return NextResponse.json(err("خطا در محاسبه کارمزد"));
  }
}
