import { CouponType } from "@/configs/coupons";
import { AllServiceTypes } from "@/configs/services";
import mongoose from "mongoose";

export interface ICouponBase {
  code: string; // کد تخفیف (مثلا YALDA1403)
  type: CouponType; // درصدی یا مبلغ ثابت
  amount: number; // مقدار (مثلا 20 درصد یا 50000 تومان)
  maxDiscount?: number; // سقف تخفیف (برای درصدی‌ها)
  minPurchase?: number; // حداقل مبلغ سبد خرید
  usageLimit?: number; // محدودیت تعداد کل استفاده
  usedCount: number; // تعداد استفاده شده تا الان
  isActive: boolean;
  description?: string;
  limitPerUser: number;
  // محدودیت‌های پیشرفته
  applicableTo: AllServiceTypes[]; // فقط برای کیف پول یا خرید بسته
}
export interface ICouponSchema extends ICouponBase {
  expireAt?: Date; // تاریخ انقضا
  usedBy: mongoose.Types.ObjectId[]; // لیست کسانی که استفاده کردند (برای جلوگیری از استفاده تکراری)

  // محدودیت‌های پیشرفته
}
export interface ICouponDeo extends ICouponBase {
  expireAt?: string; // تاریخ انقضا
  usedBy: string[]; // لیست کسانی که استفاده کردند (برای جلوگیری از استفاده تکراری)
}

export interface IAppliedCoupon {
  code: string;
  amount: number; // مقدار تخفیف این کد خاص
  id: string;
  description?: string;
}
export interface MultipleCouponResult {
  isValid: boolean;
  finalAmount: number;
  totalDiscount: number;
  appliedCoupons: IAppliedCoupon[];
  errors: string[]; // لیست خطاهای کدهایی که اعمال نشدند
}
