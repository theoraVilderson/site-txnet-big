import { ICouponLockSchema } from "@/types/couponLocks";
import mongoose, { Schema, Document, model, models } from "mongoose";

const CouponLockSchema = new Schema<ICouponLockSchema>(
  {
    couponCode: { type: String, required: true },
    couponId: { type: Schema.Types.ObjectId, ref: "Coupon", required: true },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    expireAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// 1. TTL Index: اتوماتیک داکیومنت را بعد از رسیدن به زمان expireAt پاک می‌کند
// نکته: expireAfterSeconds: 0 یعنی دقیقاً در زمان expireAt پاک شود
CouponLockSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

// 2. Compound Unique Index: یک کاربر نمی‌تواند یک کد تخفیف را دو بار رزرو کند (جلوگیری از Hoarding)
CouponLockSchema.index({ couponCode: 1, user: 1 }, { unique: true });

const CouponLocks =
  (models.CouponLocks as mongoose.Model<ICouponLockSchema>) ||
  model<ICouponLockSchema>("CouponLocks", CouponLockSchema);
export default CouponLocks;
