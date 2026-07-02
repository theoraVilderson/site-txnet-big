import { PaymentProvider } from "@/configs/paymentSettings";
import { TransactionStatus, TransactionType } from "@/configs/transactions";
import { Types } from "mongoose";
import { z } from "zod";

const phoneRegex = /^09[0-9]{9}$/;

export const loginSchema = z.object({
  phone: z
    .string({ message: "شماره موبایل الزامی است و باید متن باشد" })
    .regex(phoneRegex, "فرمت شماره موبایل صحیح نیست"),
  captchaTokens: z.object(
    {
      verifyToken: z
        .string({ message: "توکن کپچا نامعتبر است" })
        .min(1, "توکن کپچا الزامی است"),
      captchaToken: z
        .string({ message: "مقدار کپچا نامعتبر است" })
        .min(1, "مقدار کپچا الزامی است"),
    },
    { message: "اطلاعات کپچا الزامی است" },
  ),
});

export const signupSchema = z.object({
  phone: z
    .string({ message: "شماره موبایل الزامی است و باید متن باشد" })
    .regex(phoneRegex, "فرمت شماره موبایل صحیح نیست"),
  name: z
    .string({ message: "نام الزامی است و باید متن باشد" })
    .min(2, "نام باید حداقل ۲ کاراکتر باشد")
    .max(30, "نام باید حداکثر ۳۰ کاراکتر باشد"),
  captchaTokens: z.object(
    {
      verifyToken: z
        .string({ message: "توکن کپچا نامعتبر است" })
        .min(1, "توکن کپچا الزامی است"),
      captchaToken: z
        .string({ message: "مقدار کپچا نامعتبر است" })
        .min(1, "مقدار کپچا الزامی است"),
    },
    { message: "اطلاعات کپچا الزامی است" },
  ),
});

export const verifyOTPSchema = z.object({
  otp: z
    .string({ message: "کد تأیید باید متن باشد" })
    .length(5, "کد ارسالی نامعتبر است (باید ۵ رقم باشد)"),
  phone: z
    .string({ message: "شماره موبایل الزامی است و باید متن باشد" })
    .regex(phoneRegex, "فرمت شماره موبایل صحیح نیست"),
});

export const chargeRequestSchema = z.object({
  amount: z
    .number({ message: "مبلغ الزامی است و باید عدد باشد" })
    .min(1, "مبلغ باید بیشتر از صفر باشد"),
  gatewayName: z.enum(PaymentProvider, {
    message: "درگاه پرداخت انتخاب‌شده نامعتبر یا خالی است",
  }),
  couponsCode: z
    .array(
      z.string().max(20, "کد تخفیف نمی‌تواند طولانی‌تر از ۲۰ کاراکتر باشد"),
    )
    .optional(),
});

export const couponCheckSchema = z.object({
  amount: z
    .number({ message: "مبلغ الزامی است و باید عدد باشد" })
    .min(1, "مبلغ باید بیشتر از صفر باشد"),
  couponsCode: z.array(
    z
      .string({ message: "کد تخفیف باید متن باشد" })
      .min(1, "کد تخفیف را وارد کنید")
      .max(20, "کد تخفیف نمی‌تواند طولانی‌تر از ۲۰ کاراکتر باشد"),
    { message: "ارسال لیست کدهای تخفیف الزامی است" },
  ),
});

export const feeCalcSchema = z.object({
  amount: z
    .number({ message: "مبلغ الزامی است و باید عدد باشد" })
    .min(1, "مبلغ باید بیشتر از صفر باشد"),
  gatewayName: z.enum(PaymentProvider, {
    message: "درگاه پرداخت انتخاب‌شده نامعتبر یا خالی است",
  }),
});

export const giftCheckSchema = z.object({
  giftCode: z
    .string({ message: "کد هدیه الزامی است و باید متن باشد" })
    .min(1, "کد هدیه را وارد کنید")
    .max(20, "کد هدیه نمی‌تواند طولانی‌تر از ۲۰ کاراکتر باشد"),
});

export const getWalletHistorySchema = z.object({
  userId: z
    .string({ message: "شناسه کاربر الزامی است و باید متن باشد" })
    .refine((val) => Types.ObjectId.isValid(val), {
      message: "شناسه کاربر (ObjectId) معتبر نیست",
    }),
  page: z
    .number({ message: "شماره صفحه باید عدد باشد" })
    .int("شماره صفحه باید عدد صحیح باشد")
    .positive("شماره صفحه باید بزرگتر از صفر باشد")
    .optional(),
  limit: z
    .number({ message: "محدودیت تعداد باید عدد باشد" })
    .int("تعداد آیتم‌ها در صفحه باید عدد صحیح باشد")
    .positive("تعداد باید بزرگتر از صفر باشد")
    .optional(),
  filters: z
    .object({
      type: z.union([
        z.enum(TransactionType, {
          message: "نوع تراکنش نامعتبر یا خالی است",
        }),
        z.literal("ALL"),
      ]),
      status: z.union([
        z.enum(TransactionStatus, {
          message: "وضعیت تراکنش نامعتبر یا خالی است",
        }),
        z.literal("ALL"),
      ]),
      search: z
        .string({ message: "متن جستجو باید رشته متنی باشد" })
        .max(100, "متن جستجو نمی‌تواند بیشتر از ۱۰۰ کاراکتر باشد")
        .optional(),
      startDate: z
        .string({ message: "تاریخ شروع باید رشته متنی باشد" })
        .max(100, "تاریخ شروع نامعتبر است")
        .optional(),
      endDate: z
        .string({ message: "تاریخ پایان باید رشته متنی باشد" })
        .max(100, "تاریخ پایان نامعتبر است")
        .optional(),
    })
    .optional(),
});
