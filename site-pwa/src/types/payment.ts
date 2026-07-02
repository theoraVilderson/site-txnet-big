// lib/payment/types.ts

import { PaymentCurrency } from "@/configs/payments";
import {
  type ErrorResponse,
  type ResponseType,
  type SuccessResponse,
} from "@/shared";
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

  request(
    params: PaymentRequestParams,
  ): Promise<ResponseType<PaymentRequestResult>>;
  verify(
    params: PaymentVerifyParams,
  ): Promise<ResponseType<PaymentVerifyResult>>;
  feeCalculation?(data: PaymentFeeParams): Promise<ResponseType<IPriceDetail>>;
}
