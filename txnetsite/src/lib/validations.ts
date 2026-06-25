import { PaymentProvider } from "@/configs/paymentSettings";
import { z } from "zod";

const phoneRegex = /^09[0-9]{9}$/;

export const loginSchema = z.object({
  phone: z.string().regex(phoneRegex, "فرمت شماره موبایل صحیح نیست"),
  captchaTokens: z.object({
    verifyToken: z.string().min(1, "کپچا الزامی است"),
    captchaToken: z.string().min(1, "کپچا الزامی است"),
  }),
});

export const signupSchema = z.object({
  phone: z.string().regex(phoneRegex, "فرمت شماره موبایل صحیح نیست"),
  name: z
    .string()
    .min(2, "نام باید حداقل ۲ کاراکتر باشد")
    .max(30, "نا باید حدکثر 30 کارکتر باشد"),
  captchaTokens: z.object({
    verifyToken: z.string().min(1, "کپچا الزامی است"),
    captchaToken: z.string().min(1, "کپچا الزامی است"),
  }),
});

export const verifyOTPSchema = z.object({
  otp: z.string().length(5, "کد ارسالی نامعتبر هست"),
  phone: z.string().regex(phoneRegex, "فرمت شماره موبایل صحیح نیست"),
});

// اعتبارسنجی ورودی با Zod
export const chargeRequestSchema = z.object({
  amount: z.number().min(1),
  gatewayName: z.enum(Object.values(PaymentProvider)),
  couponsCode: z.array(z.string().max(20)).optional(),
});

// 1. تعریف اسکیما برای اعتبارسنجی ورودی
// (بهتر است این را به فایل @lib/validations ببرید)
export const couponCheckSchema = z.object({
  amount: z.number().min(1), // مبلغ به ریال
  couponsCode: z.array(z.string().min(1, "کد تخفیف را وارد کنید").max(20)),
});

export const feeCalcSchema = z.object({
  amount: z.number().min(1),
  gatewayName: z.enum(Object.values(PaymentProvider)),
});

export const giftCheckSchema = z.object({
  giftCode: z.string().min(1, "کد هدیه را وارد کنید").max(20),
});
