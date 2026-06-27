import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import connectDB from "@/lib/db";
import Transactions from "@/models/Transactions";
import Users from "@/models/Users";
import { PaymentFactory } from "@/lib/payment/gateway/paymentFactory";
import { PaymentProvider } from "@/configs/paymentSettings";
import { TransactionStatus } from "@/configs/transactions";
import { PAYMENT_URL } from "@/env";
import logger from "@lib/logger";
import { CouponService } from "@lib/payment/coupon/couponService";
const baseUrl = PAYMENT_URL;
export const successRedirect = `${baseUrl}/payment/success`;
export const failedRedirect = `${baseUrl}/payment/failed`;

export const redirectToError = (code: string) => {
  return NextResponse.redirect(`${failedRedirect}?error=${code}`);
};
// این تابع "موتور" نهایی‌سازی تراکنش شماست
export async function fulfillWalletChargeTransaction(
  transactionId: string | mongoose.Types.ObjectId,
  refId: string,
  session: mongoose.ClientSession
) {
  // ۱. آپدیت وضعیت تراکنش به موفق
  const finalTx = await Transactions.findOneAndUpdate(
    { _id: transactionId, status: { $ne: TransactionStatus.SUCCESS } },
    {
      $set: {
        title: "پرداخت موفق",
        status: TransactionStatus.SUCCESS,
        refId: refId,
      },
      $unset: { expireAt: 1 } 
    },
    { session, new: true }
  );

  if (!finalTx) {
   // چک می‌کنیم آیا به خاطر موفق بودن آپدیت نشده؟
   const checkTx = await Transactions.findById(transactionId).session(session);
   if (checkTx && checkTx.status === TransactionStatus.SUCCESS) {
     // این یعنی ریکوئست همزمان قبلی کار را تمام کرده، پس ارور نده!
     return checkTx; 
   }
    throw new Error("تراکنش یافت نشد یا غیرقابل پردازش است");
  }
  // ۲. افزایش موجودی کاربر
  const updatedUser = await Users.findByIdAndUpdate(
    finalTx.user,
    { $inc: { walletBalance: finalTx.amount } },
    { session }
  );
  if (!updatedUser) throw new Error("کاربر یافت نشد");

  // ۳. نهایی کردن کوپن‌ها (اگر وجود داشت)
  const couponCodes = finalTx.couponsCode?.map((e: any) => e.code) || [];
  if (couponCodes.length > 0) {
    await CouponService.commitCoupons(
      finalTx.user.toString(),
      couponCodes,
      session
    );
  }

  return finalTx;
}
export async function GET(req: NextRequest) {
  await connectDB();
  const searchParams = req.nextUrl.searchParams;
  const authority = searchParams.get("Authority");

  if (!authority) return redirectToError("INVALID_PARAMS");

  // ۱. واکشی اولیه تراکنش
  const transaction = await Transactions.findOne({ authority });
  if (!transaction) return redirectToError("TRANSACTION_NOT_FOUND");

  // بررسی Idempotency
  if (transaction.status === TransactionStatus.SUCCESS) {
    return NextResponse.redirect(
      `${successRedirect}?ref=${transaction.refId}&already_paid=true`
    );
  }

  // ۲. استعلام از درگاه (بیرون از تراکنش دیتابیس)
  let verifyResult;
  try {
    const providerName =
      (transaction.gatewayName as PaymentProvider) || PaymentProvider.ZARINPAL;

    const paymentStrategy = await PaymentFactory.getProvider(providerName);
    const totalAmount =
      transaction.amount +
      (transaction.feeAmount || 0) +
      (transaction.taxAmount || 0) +
      -(transaction.discountAmount || 0);

    verifyResult = await paymentStrategy.verify({
      amount: totalAmount,
      authority: authority,
    });
  } catch (error) {
    logger.error(`Gateway Verify Error:`, error);
    return redirectToError("GATEWAY_CONNECTION_ERROR");
  }

  // ۳. شروع عملیات حساس دیتابیس
  const session = await mongoose.startSession();
  session.startTransaction();
  logger.info(verifyResult);
  try {
    const couponCodes = transaction.couponsCode?.map((e: any) => e.code) || [];

    // حالت الف: پرداخت ناموفق در بانک
    if (!verifyResult.ok || !verifyResult.data) {
      await Transactions.updateOne(
        { _id: transaction._id ,status: TransactionStatus.PENDING},
        {
          $set: {
            status: TransactionStatus.FAILED,
            title: verifyResult.msg || "پرداخت ناموفق",
          },
          $unset: { expireAt: 1 } 
        },
        { session }
      );

      if (couponCodes.length > 0) {
        await CouponService.releaseLocks(
          transaction.user.toString(),
          couponCodes,
          session
        );
      }

      await session.commitTransaction();
      return redirectToError("VERIFICATION_FAILED");
    }

    await fulfillWalletChargeTransaction(
      transaction._id,
      verifyResult.data.refId,
      session
    );

    await session.commitTransaction();
    return NextResponse.redirect(
      `${successRedirect}?ref=${verifyResult.data.refId}`
    );
  } catch (error) {
    await session.abortTransaction();
    logger.error(`Critical Payment Error:`, error);

    return redirectToError("SYSTEM_ERROR");
  } finally {
    session.endSession();
  }
}
