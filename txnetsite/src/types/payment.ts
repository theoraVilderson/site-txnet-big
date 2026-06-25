// lib/payment/types.ts

import { PaymentCurrency } from "@/configs/payments";
import { LastResType } from "@/shared";
import { IPriceDetail } from "@lib/payment/fee/feeAndTaxCalculator";
import { IPaymentSetting } from "./paymentSetting";

// ورودی برای درخواست پرداخت
export interface PaymentRequestParams {
  amount: number;
  callbackUrl: string;
  description: string;
  email?: string;
  mobile?: string;
  currency?: PaymentCurrency;
}

// خروجی درخواست پرداخت (لینک هدایت کاربر)
export interface PaymentRequestResult {
  url: string;
  authority: string; // شناسه یکتا که درگاه میده
  paymentInfo: IPriceDetail; // شناسه یکتا که درگاه میده
}

// ورودی برای وریفای کردن
export interface PaymentVerifyParams {
  authority: string;
  amount: number;
}

// خروجی وریفای (شماره تراکنش موفق)
export interface PaymentVerifyResult {
  refId: string;
  cardPan?: string;
}
export interface PaymentFeeParams {
  amount: number;
  currency?: string;
}
// اینترفیس اصلی که همه درگاه‌ها باید داشته باشند
export interface IPaymentStrategy {
  providerSettings: IPaymentSetting;

  request(params: PaymentRequestParams): Promise<
    LastResType<{
      url: string;
      authority: any;
      paymentInfo: IPriceDetail;
    } | null>
  >;
  verify(
    params: PaymentVerifyParams
  ): Promise<LastResType<PaymentVerifyResult | null>>;
  feeCalculation?(data: PaymentFeeParams): Promise<
    | {
        failed: boolean;
        ok: boolean;
        data: IPriceDetail;
        msg: string;
      }
    | {
        failed: boolean;
        ok: boolean;
        data: null;
        msg: string;
      }
  >;
}
