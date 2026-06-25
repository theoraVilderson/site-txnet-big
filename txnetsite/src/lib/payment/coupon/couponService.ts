import mongoose, { ClientSession } from "mongoose";
import Coupons from "@/models/Coupons";
import CouponLocks from "@/models/CouponLocks";
import connectDB from "@/lib/db";
import { AllServiceTypes } from "@/configs/services";
import {
  calculateCouponDiscount,
  checkStaticCouponRules,
} from "@/lib/couponHelpers";
import { MultipleCouponResult } from "@/types/coupons";

// --- Helper: بررسی ظرفیت داینامیک ---
async function checkCapacityWithLocks(
  coupon: any,
  userId: string,
  session: ClientSession | null = null
) {
  if (!coupon.usageLimit) return null;

  const query = CouponLocks.countDocuments({
    couponId: coupon._id,
    user: { $ne: userId },
    expireAt: { $gt: new Date() },
  });

  if (session) query.session(session);

  const lockedCount = await query;

  if (coupon.usedCount + lockedCount >= coupon.usageLimit) {
    return `ظرفیت کد ${coupon.code} تکمیل شده است (در انتظار پرداخت دیگران).`;
  }
  return null;
}

export const CouponService = {
  /**
   * ۱. اعتبارسنجی دقیق
   */
  async validateCoupons(
    codes: string[],
    baseAmount: number,
    userId: string,
    serviceType: AllServiceTypes = AllServiceTypes.WALLET,
    session: ClientSession | null = null
  ): Promise<MultipleCouponResult> {
    await connectDB();

    const normalizedCodes = [
      ...new Set(codes.filter((c) => c).map((c) => c.trim().toUpperCase())),
    ];

    if (normalizedCodes.length === 0) {
      return {
        isValid: true,
        finalAmount: baseAmount,
        totalDiscount: 0,
        appliedCoupons: [],
        errors: [],
      };
    }

    const query = Coupons.find({
      code: { $in: normalizedCodes },
      isActive: true,
    }).lean();
    if (session) query.session(session);
    const coupons = await query;

    let currentPayable = baseAmount;
    let totalDiscount = 0;
    const appliedCouponsDetails = [];
    const errors: string[] = [];

    for (const code of normalizedCodes) {
      const coupon = coupons.find((c) => c.code === code);

      if (!coupon) {
        errors.push(`کد ${code} نامعتبر است.`);
        continue;
      }

      const staticError = checkStaticCouponRules(
        coupon,
        userId,
        baseAmount,
        serviceType
      );
      if (staticError) {
        errors.push(staticError);
        continue;
      }

      const lockError = await checkCapacityWithLocks(coupon, userId, session);
      if (lockError) {
        errors.push(lockError);
        continue;
      }

      let discountAmount = 0;
      if (currentPayable > 0) {
        discountAmount = calculateCouponDiscount(coupon, currentPayable);
      }

      currentPayable = Math.max(0, currentPayable - discountAmount);
      totalDiscount += discountAmount;

      appliedCouponsDetails.push({
        code: coupon.code,
        amount: discountAmount,
        description: coupon.description,
        id: coupon._id.toString(),
      });
    }

    return {
      isValid: errors.length === 0,
      finalAmount: currentPayable,
      totalDiscount,
      appliedCoupons: appliedCouponsDetails,
      errors,
    };
  },

  /**
   * ۲. رزرو و قفل کردن
   * نکته مهم: اگر session پاس داده شود، مدیریت commit/abort با فراخواننده است.
   */
  async reserveCoupons(
    userId: string,
    codes: string[],
    orderAmount: number,
    serviceType: AllServiceTypes = AllServiceTypes.WALLET,
    targetSession: ClientSession | null = null
  ) {
    await connectDB();

    // اگر سشن خارجی پاس داده شده باشد، از همان استفاده می‌کنیم.
    // اگر نه، یک سشن جدید می‌سازیم.
    const session = targetSession || (await mongoose.startSession());

    // فقط اگر سشن داخلی باشد (ما ساختیمش)، تراکنش را شروع می‌کنیم.
    const isInternalSession = !targetSession;
    if (isInternalSession) {
      session.startTransaction();
    }

    try {
      const validationResult = await this.validateCoupons(
        codes,
        orderAmount,
        userId,
        serviceType,
        session
      );

      if (!validationResult.isValid || validationResult.errors.length > 0) {
        throw new Error(validationResult.errors.join("\n"));
      }

      const reservedDetails = [];

      for (const applied of validationResult.appliedCoupons) {
        await CouponLocks.findOneAndUpdate(
          { couponCode: applied.code, user: userId },
          {
            couponCode: applied.code,
            couponId: applied.id,
            user: userId,
            expireAt: new Date(Date.now() + 20 * 60 * 1000),
          },
          { upsert: true, new: true, session }
        );

        reservedDetails.push({
          code: applied.code,
          discount: applied.amount,
        });
      }

      // فقط اگر سشن داخلی باشد، ما کامیت می‌کنیم.
      if (isInternalSession) {
        await session.commitTransaction();
      }

      return {
        totalDiscount: validationResult.totalDiscount,
        finalAmount: validationResult.finalAmount,
        details: reservedDetails,
      };
    } catch (error) {
      // فقط اگر سشن داخلی باشد، ما abort می‌کنیم.
      if (isInternalSession) {
        await session.abortTransaction();
      }
      throw error;
    } finally {
      // فقط اگر سشن داخلی باشد، آن را می‌بندیم.
      if (isInternalSession) {
        session.endSession();
      }
    }
  },

  /**
   * ۳. مصرف نهایی (Commit)
   * این متد معمولا داخل یک تراکنش بزرگتر (مثلا تکمیل سفارش) صدا زده می‌شود.
   */
  async commitCoupons(
    userId: string,
    codes: string[],
    targetSession: ClientSession | null = null
  ) {
    await connectDB();
    // در اینجا فرض بر این است که معمولاً session از بیرون می‌آید (چون بخشی از پرداخت موفق است)
    // اما برای اطمینان منطق internal/external را رعایت می‌کنیم
    const session = targetSession || (await mongoose.startSession());
    const isInternalSession = !targetSession;

    if (isInternalSession) session.startTransaction();

    try {
      const uniqueCodes = [
        ...new Set(codes.filter((c) => c).map((c) => c.trim().toUpperCase())),
      ];

      for (const code of uniqueCodes) {
        // ۱. حذف قفل
        await CouponLocks.deleteOne({ couponCode: code, user: userId }).session(
          session
        );

        // ۲. آپدیت کوپن (افزایش تعداد استفاده و ثبت کاربر)
        await Coupons.findOneAndUpdate(
          { code },
          {
            $inc: { usedCount: 1 },
            $push: { usedBy: userId },
          }
        ).session(session);
      }

      if (isInternalSession) await session.commitTransaction();
    } catch (error) {
      if (isInternalSession) await session.abortTransaction();
      throw error;
    } finally {
      if (isInternalSession) session.endSession();
    }
  },

  /**
   * ۴. آزادسازی قفل‌ها (Release)
   * برای مواقعی که پرداخت ناموفق بوده یا کنسل شده
   */
  async releaseLocks(
    userId: string,
    codes: string[],
    targetSession: ClientSession | null = null
  ) {
    await connectDB();
    if (!codes?.length) return;

    const uniqueCodes = [
      ...new Set(codes.filter((c) => c).map((c) => c.trim().toUpperCase())),
    ];

    // در release معمولاً نیازی به تراکنش سنگین نیست، اما اگر پاس داده شد استفاده می‌کنیم
    const query = CouponLocks.deleteMany({
      couponCode: { $in: uniqueCodes },
      user: userId,
    });

    if (targetSession) query.session(targetSession);

    await query;
  },
};
