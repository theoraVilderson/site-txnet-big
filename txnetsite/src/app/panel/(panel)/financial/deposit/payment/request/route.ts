import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import connectDB from "@/lib/db";
import Transactions from "@/models/Transactions";
import Users from "@/models/Users";
import { PaymentFactory } from "@/lib/payment/gateway/paymentFactory";
import { FeeCurrency, PaymentProvider } from "@/configs/paymentSettings";
import {
  TransactionType,
  TransactionDirection,
  TransactionMethod,
  TransactionStatus,
} from "@/configs/transactions";
import { sendAsRes, zodErrorToString } from "@util/helper";
import { chargeRequestSchema } from "@lib/validations";
import logger from "@lib/logger";
import mongoose from "mongoose"; 
import { PAYMENT_URL } from "@/env";
import { getValidatedUser } from "@lib/auth";
import { PaymentCurrency } from "@/configs/payments";
import { AllServiceTypes } from "@/configs/services";
import { CouponService } from "@lib/payment/coupon/couponService";
import { IAppliedCoupon } from "@/types/coupons";
import {
  fulfillWalletChargeTransaction,
  successRedirect,
} from "@app/payment/verify/route";


export async function POST(req: NextRequest) {
  try {
    const validatedUser = await getValidatedUser();
    if (!validatedUser)
      return NextResponse.json(sendAsRes(null, "Unauthorized", false), {
        status: 401,
      });

    await connectDB();
    const body = await req.json();
    const validation = chargeRequestSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        sendAsRes(null, zodErrorToString(validation.error)),
        { status: 400 }
      );
    }

    let {
      amount: baseAmountInRial,
      gatewayName,
      couponsCode = [],
    } = validation.data;
    const userId = validatedUser.userId;

    // ۱. بررسی وجود کاربر
    const user = await Users.findById(userId).select("phone _id").lean();
    if (!user)
      return NextResponse.json(sendAsRes(null, "User not found", false), {
        status: 404,
      });

    // ۲. تنظیمات درگاه
    const providerName = gatewayName as PaymentProvider;
    const paymentStrategy = await PaymentFactory.getProvider(providerName);
    const { maxAmountAccept = 500_000_000, minAmountAccept = 10000,feeConfig  } =
      paymentStrategy.providerSettings;
    // ۲. نرمال‌سازی به ریال
    const currencyMultiplier = feeConfig.currency === FeeCurrency.IRT ? 10 : 1;
    const normalizedMinAmount = minAmountAccept * currencyMultiplier;
    const normalizedMaxAmount = maxAmountAccept * currencyMultiplier;
  // ۳. مقایسه ایمن
  if (
    baseAmountInRial < normalizedMinAmount ||
    baseAmountInRial > normalizedMaxAmount
  ) {
    return NextResponse.json(
      sendAsRes(
        null,
        `مبلغ باید بین ${normalizedMinAmount / 10} و ${normalizedMaxAmount / 10} تومان باشد`
      ),
      { status: 400 }
    );
  }
    // ۳. محاسبه تخفیف و کوپن
    let finalAmount = baseAmountInRial;
    let discountAmount = 0;
    let appliedCouponsData: IAppliedCoupon[] = [];

    if (couponsCode.length > 0) {
      const couponResult = await CouponService.validateCoupons(
        couponsCode,
        baseAmountInRial,
        userId,
        AllServiceTypes.WALLET
      );

      if (couponResult.appliedCoupons.length > 0) {
        try {
          const reserve = await CouponService.reserveCoupons(
            userId,
            couponResult.appliedCoupons.map((c) => c.code),
            baseAmountInRial
          );
          finalAmount = reserve.finalAmount;
          discountAmount = reserve.totalDiscount;
          appliedCouponsData = couponResult.appliedCoupons;
        } catch (error: any) {
          return NextResponse.json(sendAsRes(null, error.message, false), {
            status: 409,
          });
        }
      }
    }

    // ۴. آماده‌سازی شیء تراکنش
    const transactionData = {
      user: user._id,
      amount: baseAmountInRial, // مبلغی که به کیف پول اضافه خواهد شد
      discountAmount,
      couponsCode: appliedCouponsData,
      type: TransactionType.DEPOSIT,
      direction: TransactionDirection.IN,
      method:
        finalAmount === 0
          ? TransactionMethod.WALLET
          : TransactionMethod.GATEWAY,
      status: TransactionStatus.PENDING,
      title:
        discountAmount > 0
          ? `شارژ کیف پول (با کد تخفیف)`
          : "افزایش موجودی کیف پول",
      expireAt: new Date(Date.now() + 20 * 60 * 1000),
    };

    // بررسی حداقل مبلغ درگاه پس از تخفیف
    // ... بعد از محاسبه تخفیف و قبل از ارسال به درگاه

    if (finalAmount > 0 && finalAmount < minAmountAccept) {
      // محاسبه مابه‌التفاوت برای رسیدن به کف مبلغ درگاه
      const adjustmentGap = minAmountAccept - finalAmount;

      // ۱. مبلغ نهایی پرداختی را به کف درگاه می‌رسانیم
      finalAmount = minAmountAccept;

      // ۲. مبلغی که قرار است به کیف پول کاربر واریز شود را افزایش می‌دهیم
      // این یعنی کاربر مبلغ بیشتری می‌دهد اما معادل همان را شارژ می‌گیرد
      transactionData.amount = (transactionData.amount || 0) + adjustmentGap;

      // ۳. ثبت در توضیحات یا عنوان برای شفافیت (اختیاری اما توصیه شده)
      transactionData.title += " (تعدیل شده به حداقل کف پرداخت)";

      logger.info(`Amount adjusted for user ${userId}. Gap: ${adjustmentGap}`);
    }

    // ۵. مدیریت حالت رایگان (Final Amount == 0)
    if (finalAmount === 0) {
      const session = await mongoose.startSession();
      try {
        session.startTransaction();

        const tx = await Transactions.create([transactionData], { session });
        await fulfillWalletChargeTransaction(tx[0]._id, "FREE_COUPON", session);
        await session.commitTransaction();
        return NextResponse.json(
          sendAsRes(
            { url: `${successRedirect}?ref=FREE` },
            "تراکنش با موفقیت انجام شد",
            true
          )
        );
      } catch (err) {
        await session.abortTransaction();
        throw err;
      } finally {
        session.endSession();
      }
    }

    // ۶. ارسال به درگاه و ثبت تراکنش (حالت عادی)
    const { failed, data: paymentRes } = await paymentStrategy.request({
      amount: finalAmount,
      callbackUrl: `${PAYMENT_URL}/verify`,
      description: `شارژ کیف پول ${user.phone}`,
      mobile: user.phone,
      currency: PaymentCurrency.IRT,
    });

    if (failed || !paymentRes) {
      return NextResponse.json(
        sendAsRes(null, "خطا در اتصال به درگاه", false),
        { status: 502 }
      );
    }

    // ذخیره تراکنش قبل از هدایت کاربر
    await Transactions.create({
      ...transactionData,
      authority: paymentRes.authority,
      taxAmount: paymentRes.paymentInfo?.taxAmount,
      feeAmount: paymentRes.paymentInfo?.feeAmount,
      gatewayName: providerName,
    });

    return NextResponse.json(
      sendAsRes({ url: paymentRes.url }, "لینک پرداخت ساخته شد", true)
    );
  } catch (error: any) {
    logger.error("Critical Payment Error:", error);
    return NextResponse.json(sendAsRes(null, "Internal Server Error", false), {
      status: 500,
    });
  }
}
