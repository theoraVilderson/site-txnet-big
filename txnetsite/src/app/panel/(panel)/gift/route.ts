// app/api/coupons/redeem-gift/route.ts
import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { giftCheckSchema } from "@lib/validations";
import { zodErrorToString } from "@util/helper";
import Users from "@/models/Users";
import { getValidatedUser } from "@lib/auth";
import { CouponService } from "@lib/payment/coupon/couponService";
import { AllServiceTypes } from "@/configs/services";
import connectDB from "@lib/db";
import Transactions from "@models/Transactions";
import {
  TransactionDirection,
  TransactionMethod,
  TransactionStatus,
  TransactionType,
} from "@/configs/transactions";
import { ITransactionSchema } from "@/types/transaction";
import { err, ok } from "@/shared";

export async function POST(req: NextRequest) {
  try {
    const validatedUser = await getValidatedUser();
    if (!validatedUser)
      return NextResponse.json(err("Unauthorized"), {
        status: 401,
      });

    await connectDB();
    const body = await req.json();
    const validation = giftCheckSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(err(zodErrorToString(validation.error)), {
        status: 400,
      });
    }
    const { giftCode } = validation.data;
    const userId = validatedUser.userId;
    const user = await Users.findById(userId).lean();
    if (!user)
      return NextResponse.json(err("User not found"), {
        status: 404,
      });
    let couponResult = await CouponService.validateCoupons(
      [giftCode],
      1,
      userId,
      AllServiceTypes.GIFT, // چون اینجا شارژ کیف پول است
    );
    if (
      !(couponResult.appliedCoupons.length && couponResult.totalDiscount > 0)
    ) {
      return NextResponse.json(
        err(couponResult.errors.join(" ") || "کد هدیه نامعتبر"),
        { status: 409 }, // 409 Conflict
      );
    }
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      try {
        const result = await CouponService.reserveCoupons(
          userId,
          couponResult.appliedCoupons.map((e) => e.code),
          1,
          AllServiceTypes.GIFT, // چون اینجا شارژ کیف پول است
          session,
        );
      } catch (error: any) {
        await session.abortTransaction();
        // اگر رزرو شکست خورد (مثلا ظرفیت پر شد)، به کاربر ارور می‌دهیم
        // خود سرویس reserveCoupons به صورت خودکار Rollback کرده است.
        return NextResponse.json(
          err(error.message),
          { status: 409 }, // 409 Conflict
        );
      }
      const obj = {
        user: new mongoose.Types.ObjectId(userId),
        title: `شارژ حساب از طریق کد هدیه ${giftCode}`,
        status: TransactionStatus.SUCCESS,
        refId: giftCode,
        expireAt: undefined,
        type: TransactionType.DEPOSIT,
        direction: TransactionDirection.IN,
        method: TransactionMethod.WALLET,
        amount: couponResult.totalDiscount,
      };
      const tx = new Transactions(obj);

      const finalTx = await tx.save({ session });

      if (!finalTx)
        throw new Error("Transaction already processed or not found");

      // افزایش موجودی کاربر
      const updatedUser = await Users.findByIdAndUpdate(
        userId,
        { $inc: { walletBalance: couponResult.totalDiscount } },
        { session },
      );
      if (!updatedUser) throw new Error("User not found");
      await CouponService.commitCoupons(userId, [giftCode], session);

      await session.commitTransaction();
      return NextResponse.json(
        ok(
          { amount: couponResult.totalDiscount },
          "کد هدیه با موفقیت اعمال شد",
        ),
      );
    } catch (e) {
      await session.abortTransaction();
      console.error(e);

      return NextResponse.json({ message: "خطای داخلی سرور" }, { status: 500 });
    } finally {
      session.endSession();
    }
  } catch (e) {
    console.error(e);

    return NextResponse.json({ message: "خطای داخلی سرور" }, { status: 500 });
  }
}
