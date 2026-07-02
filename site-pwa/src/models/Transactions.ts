import mongoose, { model, models } from "mongoose";
import { ITransactionSchema } from "@/types/transaction";
import {
  TransactionDirection,
  TransactionMethod,
  TransactionStatus,
  TransactionType,
} from "@/configs/transactions";
import { PaymentProvider } from "@/configs/paymentSettings";

const transactionSchema = new mongoose.Schema<ITransactionSchema>({
  // user here is the user id we named it because after populate it the name be more clear 

  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },

  // نوع تراکنش: واریز، خرید، یا مصرف سرویس
  type: {
    type: String,
    enum: Object.values(TransactionType),
    required: true,
  },

  // جهت پول: ورودی (IN) یا خروجی (OUT)
  direction: {
    type: String,
    enum: Object.values(TransactionDirection),
    required: true,
  },

  // وضیعت
  status: {
    type: String,
    enum: Object.values(TransactionStatus),
    required: true,
  },
  method: {
    type: String,
    enum: Object.values(TransactionMethod),
    required: true,
  },
  // مبلغ کل این تراکنش (برای مصرف روزانه، این عدد مدام آپدیت می‌شود)
  amount: {
    type: Number,
    required: true,
  },

  // عنوانی که به کاربر نشان می‌دهیم
  title: { type: String },
  authority: { type: String, unique: true, sparse: true }, // شناسه یکتا درگاه
  refId: { type: String }, // شماره مرجع تراکنش موفق
  gatewayName: { type: String, enum: Object.values(PaymentProvider) }, // شماره مرجع تراکنش موفق
  // تاریخ ایجاد (برای مرتب‌سازی)
  createdAt: { type: Date, default: Date.now },
  expireAt: { type: Date, default: undefined },
  taxAmount: Number,
  feeAmount: Number,
  couponsCode: [
    {
      code: String,
      amount: Number,
      description: String,
      id: mongoose.Types.ObjectId,
      _id: false,
    },
  ], // کد تخفیف استفاده شده
  discountAmount: Number, // مبلغی که کسر شد
  // این فیلد جدید را اضافه کنید (مثلا expireAt)

  // --- مخصوص الگوی Bucket (برای سرویس مازاد) ---
  // اگر نوع تراکنش USAGE_DAILY بود، جزئیات ریز اینجا می‌ریزد
  usageDetails: [
    {
      serviceId: String,
      cost: Number,
      timestamp: { type: Date, default: Date.now },
      reason: String, // مثلا: "درخواست API شماره 5"
      couponsCode: [String], // کد تخفیف استفاده شده
      discountAmount: Number, // مبلغی که کسر شد
    },
  ],
});

// ---------------------------------------------------------
// 2. ایندکس‌های پرفورمنس (Performance)
// ---------------------------------------------------------
// برای پیدا کردن آخرین باکت مصرف روزانه کاربر (مرتب‌سازی نزولی زمان)
transactionSchema.index({ user: 1, type: 1, createdAt: -1 });
/**
 * Transactions Model
 */
const Transactions =
  (models.Transactions as mongoose.Model<ITransactionSchema, {}>) ||
  model<ITransactionSchema>("Transactions", transactionSchema);

export default Transactions;
