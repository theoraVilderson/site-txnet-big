import {
  FeeCurrency,
  FeeMode,
  FeeType,
  PaymentProvider,
} from "@/configs/paymentSettings";
import { IPaymentSetting } from "@/types/paymentSetting";
import mongoose, { Schema, Model, models } from "mongoose";

// 2. اسکیما
const PaymentSettingsSchema = new Schema<IPaymentSetting>(
  {
    taxRate: { type: Number, required: true, default: 10 },
    feeConfig: {
      mode: {
        type: String,
        enum: Object.values(FeeMode),
        default: FeeMode.MANUAL,
      },
      type: {
        type: String,
        enum: Object.values(FeeType),
        default: FeeType.FIXED,
      },
      value: { type: Number, required: true, default: 0 },
      currency: {
        type: String,
        enum: Object.values(FeeCurrency),
        default: FeeCurrency.IRT,
      },
      minLimit: Number,
      maxLimit: Number,
    },
    minAmountAccept: { type: Number, required: true },
    maxAmountAccept: { type: Number, required: true },
    displayName: { type: String, required: true },
    description: { type: String },
    gatewayName: {
      type: String,
      enum: Object.values(PaymentProvider),
      required: true,
    },
    merchantId: { type: String, select: false }, // امنیتی: این فیلد دیفالت برنمی‌گردد
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// 3. جلوگیری از کامپایل مجدد مدل در هات‌ریلود Next.js
const PaymentSettings =
  (models.PaymentSettings as Model<IPaymentSetting>) ||
  mongoose.model<IPaymentSetting>("PaymentSettings", PaymentSettingsSchema);

export default PaymentSettings;
