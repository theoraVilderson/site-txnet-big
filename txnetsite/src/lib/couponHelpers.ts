import { CouponType } from "@/configs/coupons";
import { AllServiceTypes } from "@/configs/services";
import { ICouponSchema } from "@/types/coupons";

export const calculateCouponDiscount = (
  coupon: ICouponSchema,
  currentPrice: number
): number => {
  let discount = 0;

  if (coupon.type === CouponType.FIXED) {
    discount = coupon.amount;
  } else if (coupon.type === CouponType.PERCENT) {
    discount = Math.floor((currentPrice * coupon.amount) / 100);
    if (coupon.maxDiscount && discount > coupon.maxDiscount) {
      discount = coupon.maxDiscount;
    }
  } else if (coupon.type === CouponType.GIFT) {
    discount = coupon.amount; 
  }

  // حالا کوپن گیفت هم نمی‌تواند بیشتر از مبلغ فعلی فاکتور تخفیف ایجاد کند
  return Math.min(discount, currentPrice);
};
// --- Helper: قوانین ثابت (بدون نیاز به دیتابیس لاک‌ها) ---
export const checkStaticCouponRules = (
  coupon: any,
  userId: string,
  baseAmount: number,
  serviceType: AllServiceTypes
): string | null => {
  // ۱. انقضا
  if (coupon.expireAt && new Date() > coupon.expireAt) {
    return `کد ${coupon.code} منقضی شده است.`;
  }
  // ۲. سرویس مجاز
  if (
    coupon.applicableTo?.length &&
    coupon.applicableTo !== "ALL" &&
    !coupon.applicableTo.includes(serviceType)
  ) {
    return `کد ${coupon.code} برای این سرویس قابل استفاده نیست.`;
  }
  // ۳. حداقل خرید
  if (coupon.minPurchase && baseAmount < coupon.minPurchase) {
    return `حداقل خرید برای کد ${coupon.code}: ${coupon.minPurchase} تومان.`;
  }
  // ۴. سقف استفاده کاربر
  const userUsageCount = coupon.usedBy.filter(
    (id: any) => id.toString() === userId
  ).length;
  if (
    coupon.limitPerUser &&
    coupon.limitPerUser > 0 &&
    userUsageCount >= coupon.limitPerUser
  ) {
    return `سقف استفاده شما از کد ${coupon.code} پر شده است.`;
  }

  return null;
};
