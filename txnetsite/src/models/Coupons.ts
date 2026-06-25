import { CouponType } from "@/configs/coupons";
import { AllServiceTypes } from "@/configs/services";
import { ICouponSchema } from "@/types/coupons";
import mongoose, { Schema, model, models } from "mongoose";

const couponSchema = new Schema<ICouponSchema>(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
    },
    type: { type: String, enum: Object.values(CouponType), required: true },
    amount: { type: Number, required: true },
    maxDiscount: { type: Number }, // مثلا ۲۰ درصد تخفیف تا سقف ۱۰۰ هزار تومان
    minPurchase: { type: Number, default: 0 },

    usageLimit: { type: Number }, // مثلا کلا ۱۰۰ نفر بتوانند استفاده کنند
    usedCount: { type: Number, default: 0 },
    limitPerUser: { type: Number, default: 1 },

    expireAt: { type: Date },
    isActive: { type: Boolean, default: true },

    applicableTo: {
      type: [String],
      enums: Object.values(AllServiceTypes),
      default: [AllServiceTypes.V2RAY],
    },
    usedBy: [{ type: Schema.Types.ObjectId, ref: "Users" }],
  },
  { timestamps: true }
);

const Coupons =
  (models.Coupons as mongoose.Model<ICouponSchema, {}>) ||
  model<ICouponSchema>("Coupons", couponSchema);
export default Coupons;
