import mongoose from "mongoose";

export interface ICouponLockBase {
  couponCode: string;
}

export interface ICouponLockSchema extends ICouponLockBase {
  couponId: mongoose.Types.ObjectId; // رفرنس برای راحتی کار
  user: mongoose.Types.ObjectId;
  expireAt: Date; // زمانی که لاک خودکار می‌پرد
}
export interface ICouponLockDto extends ICouponLockBase {
  couponId: string; // رفرنس برای راحتی کار
  user: string;
  expireAt: string; // زمانی که لاک خودکار می‌پرد
}
