import {
  FeeCurrency,
  FeeMode,
  FeeType,
  PaymentProvider,
} from "@/configs/paymentSettings";

// 1. اینترفیس دیتای خام در دیتابیس
export interface IPaymentSetting {
  taxRate: number; // مثلا 0.09
  feeConfig: {
    mode: FeeMode;
    type: FeeType; // نوع محاسبه (ثابت یا درصدی)
    value: number; // مقدار (مثلا 2 برای 2% یا 5000 برای 5000 تومان)
    currency: FeeCurrency;
    minLimit?: number;
    maxLimit?: number;
  };
  minAmountAccept: number;
  maxAmountAccept: number;
  description?: string;
  displayName: string;
  gatewayName: PaymentProvider; // نام درگاه
  merchantId?: string; // (اختیاری) سمت سرور میماند
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type IPaymentSettingClient = Omit<IPaymentSetting, "merchantId"> & {
  _id: string;
};
export interface IPaymentSettingWithDocument
  extends IPaymentSetting,
    Document {}
