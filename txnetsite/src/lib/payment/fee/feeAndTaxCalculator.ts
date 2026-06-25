import { FeeType, FeeMode } from "@/configs/paymentSettings";
import { PaymentFeeParams } from "@/types/payment";
import { IPaymentSetting } from "@/types/paymentSetting";
import { number } from "framer-motion";

export interface IPriceDetail {
  baseAmount: number; // مبلغ اصلی (مثلا قیمت محصول)
  taxAmount: number; // مبلغ مالیات
  feeAmount: number; // مبلغ کارمزد درگاه
  totalAmount: number; // مبلغ نهایی که کاربر باید پرداخت کند
  currency: string; // ارز (IRT)
}

/**
 * محاسبه قیمت نهایی شامل مالیات و کارمزد
 * @param baseAmount مبلغ پایه (تومان)
 * @param settings تنظیمات خوانده شده از دیتابیس
 * @param apiFunction اگه نیاز از طریق سایت فهمید!
 */
export async function calculatePaymentAmount(
  baseAmount: number,
  settings: IPaymentSetting,
  apiFunction: (params: PaymentFeeParams) => Promise<number> = async () => 0
): Promise<IPriceDetail> {
  const { taxRate, feeConfig } = settings;

  const isOverLimit = baseAmount > settings.maxAmountAccept;
  const isUnderLimit = baseAmount < settings.minAmountAccept;
  const isInvalidAmout = isOverLimit || isUnderLimit;
  if (isInvalidAmout) {
    const messageOverLimit = `مقدار وارد شده بیش از حداکثر مبلغ درگاه است ${settings.maxAmountAccept}`;
    const messageUnderLimit = `مقدار وارد شده کم تر از حداقل مبلغ درگاه است ${settings.minAmountAccept}`;
    const message = isOverLimit ? messageOverLimit : messageUnderLimit;
    throw new Error(message);
  }
  // 1. محاسبه کارمزد (Fee)
  let calculatedFee = 0;

  // اگر حالت محاسبه دستی باشد
  if (feeConfig.mode === FeeMode.MANUAL) {
    if (feeConfig.type === FeeType.FIXED) {
      // حالت ثابت: مثلاً ۵۰۰۰ تومان
      calculatedFee = feeConfig.value;
    } else if (feeConfig.type === FeeType.PERCENT) {
      // حالت درصدی: مثلاً ۱ درصد از مبلغ کل
      calculatedFee = baseAmount * (feeConfig.value / 100);
    }

    // اعمال محدودیت‌های کف و سقف (Min/Max Limit)
    if (feeConfig.minLimit && calculatedFee < feeConfig.minLimit) {
      calculatedFee = feeConfig.minLimit;
    }
    if (feeConfig.maxLimit && calculatedFee > feeConfig.maxLimit) {
      calculatedFee = feeConfig.maxLimit;
    }
  } else {
    // اگر حالت API باشد، معمولا کارمزد صفر در نظر گرفته می‌شود تا بعداً از درگاه استعلام شود
    // یا می‌توانید منطق دیگری پیاده کنید

    calculatedFee = await apiFunction({ amount: baseAmount });
  }

  // 2. محاسبه مالیات (Tax)
  // معمولاً مالیات روی "مبلغ پایه" اعمال می‌شود، نه روی کارمزد
  // فرمول: مبلغ * (درصد مالیات / ۱۰۰)
  const calculatedTax = baseAmount * (taxRate / 100);

  // 3. محاسبه مجموع (Total)
  // مبلغ نهایی = مبلغ پایه + مالیات + کارمزد
  const totalAmount = baseAmount + calculatedTax + calculatedFee;

  return {
    baseAmount: Math.round(baseAmount),
    taxAmount: Math.round(calculatedTax),
    feeAmount: Math.round(calculatedFee),
    totalAmount: Math.round(totalAmount), // رند کردن برای جلوگیری از اعشار
    currency: feeConfig.currency,
  };
}
