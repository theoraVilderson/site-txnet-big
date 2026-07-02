import axios, { AxiosInstance } from "axios";
// فرض بر این است که مسیرهای ایمپورت شما درست هستند
import {
  IPaymentStrategy,
  PaymentFeeParams,
  PaymentRequestParams,
  PaymentVerifyParams,
  type PaymentRequestResult,
} from "@/types/payment";
import { IPaymentSetting } from "@/types/paymentSetting";
import {
  calculatePaymentAmount,
  IPriceDetail,
} from "@lib/payment/fee/feeAndTaxCalculator";
import { ErrorParser, requestHandler } from "@lib/request";
import logger from "@lib/logger";
import { err, ok, type ResponseType } from "@/shared";

// لیست کدهای خطا
export const zarinpalErrorStates: Record<string, string> = {
  "100": "عملیات موفق",
  "101": "تراکنش وریفای شده است.",
  "-9": "خطای اعتبارسنجی داده‌های ورودی.",
  "-10": "ای پی و يا مرچنت كد پذيرنده صحيح نيست.",
  "-11": "مرچنت کد فعال نیست لطفا با پشتیبانی تماس بگیرید.",
  "-12": "تلاش بیش از دفعات مجاز در یک بازه زمانی کوتاه.",
  "-15": "ترمینال شما به حالت تعلیق در آمده با پشتیبانی تماس بگیرید.",
  "-16": "سطح تایید پذیرنده پایین تر از سطح نقره ای است.",
  "-30": "اجازه دسترسی به تسویه اشتراکی شناور ندارید.",
  "-31": "حساب بانکی تسویه را به پنل اضافه کنید.",
  "-32": "مبلغ وارد شده از مبلغ کل تراکنش بیشتر است.",
  "-33": "درصدهای وارد شده صحیح نیست.",
  "-34": "مبلغ وارد شده از مبلغ کل تراکنش بیشتر است.",
  "-39": "خطایی رخ داده است به امور مشتریان زرین پال اطلاع دهید",
  "-40": "Invalid extra params, expire_in is not valid.",
  "-50": "مبلغ پرداخت شده با مقدار مبلغ ارسالی در متد وریفای متفاوت است.",
  "-51": "پرداخت ناموفق",
  "-52": "خطای غیر منتظره‌ای رخ داده است.",
  "-53": "اتوریتی متعلق به این مرچنت کد نیست.",
  "-54": "اتوریتی نامعتبر است.",
};

export class ZarinpalProvider implements IPaymentStrategy {
  public providerSettings: IPaymentSetting;
  private sandbox: boolean;
  private merchantId: string;
  private paymentReq: AxiosInstance;

  constructor(providerSettings: IPaymentSetting, sandbox: boolean = false) {
    this.providerSettings = providerSettings;
    this.merchantId = this.providerSettings.merchantId!;
    this.sandbox = sandbox;

    // تنظیم BaseURL در زمان ساخت Instance
    this.paymentReq = axios.create({
      baseURL: this.paymentBaseURL,
      timeout: 15000, // اضافه کردن تایم‌اوت مناسب
    });
  }

  private baseURL(sandbox = this.sandbox) {
    return `https://${sandbox ? "sandbox" : "payment"}.zarinpal.com/pg`;
  }
  private get baseURLAPI() {
    return `${this.baseURL()}/v4`;
  }
  private get paymentBaseURL() {
    return `${this.baseURLAPI}/payment`;
  }

  /**
   * مفسر خطای اختصاصی زرین‌پال
   */
  private zarinpalParser: ErrorParser = (error: any) => {
    // 1. بررسی ارورهایی که از سمت سرور زرین‌پال (HTTP Error) یا Throw دستی ما می‌آیند
    const responseData = error?.response?.data;

    // زرین‌پال معمولا خطا را در errors.code یا data.code برمی‌گرداند
    let code = responseData?.errors?.code?.toString();

    // گاهی اوقات زرین‌پال در data.code خطا را می‌فرستد (در نسخه جدید)
    if (!code && responseData?.data?.code) {
      code = responseData.data.code.toString();
    }

    if (code && code in zarinpalErrorStates) {
      return zarinpalErrorStates[code];
    }

    if (responseData?.message) return responseData.message;

    return null;
  };

  /**
   * متد درخواست پرداخت
   */
  async request(params: PaymentRequestParams) {
    return await requestHandler(
      async () => {
        // محاسبه کارمزد (بهتر است خارج از ترای/کچ اصلی زرین پال باشد یا هندل شود)
        const paymentInfo = await this.feeCalculation({
          amount: params.amount,
        });
        if (!paymentInfo.ok) return paymentInfo;
        // ارسال درخواست
        const { data } = await this.paymentReq.post<
          ResponseType<{ code: number; authority: string }>
        >(`/request.json`, {
          merchant_id: this.merchantId, // توجه: در داکیومنت جدید merchant_id است نه merchantId
          amount: paymentInfo.data.totalAmount,
          currency: params?.currency || "IRT",
          callback_url: params.callbackUrl,
          description: params.description,
          metadata: {
            email: params.email,
            mobile: params.mobile,
          },
        });
        if (!data.ok) return data;
        // بررسی موفقیت (کد ۱۰۰)
        if (data.data.code === 100) {
          const authority = data.data.authority as string;
          const paymentUrl = `${this.baseURL()}/StartPay/${authority}`;
          return ok(
            {
              url: paymentUrl,
              authority,
              paymentInfo: paymentInfo.data,
            } as PaymentRequestResult,
            "پرداخت با موفقیت آغاز شد",
          );
        }

        // اگر کد ۱۰۰ نبود، خطا را پرتاب می‌کنیم تا توسط requestHandler و parser مدیریت شود
        throw { response: { data } };
      },
      {
        maxRetries: 3,
        errorParser: this.zarinpalParser,
        defaultErrorMessage: "خطا در ایجاد شناسه پرداخت زرین‌پال",
      },
    );
  }

  /**
   * متد کمکی برای جلوگیری از تکرار کد در verify و isVerified
   */
  private async _verifyCall(params: PaymentVerifyParams) {
    const { data } = await this.paymentReq.post(`/verify.json`, {
      merchant_id: this.merchantId,
      amount: params.amount,
      authority: params.authority,
    });
    return data;
  }

  /**
   * متد تایید پرداخت (فقط بار اول)
   */
  async verify(params: PaymentVerifyParams) {
    return await requestHandler(
      async () => {
        const data = await this._verifyCall(params);

        // کد ۱۰۰: عملیات موفقیت آمیز
        if (data.data && data.data.code === 100) {
          return ok(
            {
              refId: data.data.ref_id,
              cardPan: data.data.card_pan,
            },
            "پرداخت با موفقیت تایید شد",
          );
        }

        // پرتاب خطا برای مدیریت توسط پارسر (مثلاً کد -50 یا -51)
        throw { response: { data } };
      },
      {
        maxRetries: 3, // برای وریفای معمولاً Retry خیلی مهم است (مثلاً اگر شبکه قطع شد)
        errorParser: this.zarinpalParser,
        defaultErrorMessage: "خطا در تایید تراکنش زرین‌پال",
      },
    );
  }

  /**
   * متد بررسی وضعیت (شامل پرداخت‌هایی که قبلاً وریفای شده‌اند)
   */
  async isVerified(params: PaymentVerifyParams) {
    return await requestHandler<{ refId: string; cardPan: string } | null>(
      async () => {
        const data = await this._verifyCall(params);

        // کد ۱۰۰: موفق
        // کد ۱۰۱: قبلاً وریفای شده (موفق)
        if (data.data && (data.data.code === 100 || data.data.code === 101)) {
          return ok(
            {
              refId: data.data.ref_id,
              cardPan: data.data.card_pan,
            },
            // پیام متفاوت بر اساس کد
            data.data.code === 101
              ? "تراکنش قبلاً تایید شده است"
              : "تراکنش تایید شد",
          );
        }

        // سایر کدها خطا محسوب می‌شوند
        throw { response: { data } };
      },
      {
        maxRetries: 3,
        errorParser: this.zarinpalParser,
        defaultErrorMessage: "خطا در استعلام وضعیت تراکنش",
      },
    );
  }

  // بخش محاسبه کارمزد بدون تغییر عمده (فقط تمیزکاری جزئی)
  public async feeCalculation(data: PaymentFeeParams) {
    try {
      const paymentAmount = await calculatePaymentAmount(
        data.amount,
        this.providerSettings,
        this.feeApiCalculation.bind(this),
      );
      return ok(paymentAmount, "با موفقیت کارمزد محاسبه شد!");
    } catch (e: any) {
      // لاگ کردن خطا مهم است
      logger.error(`Fee Calculation Error ${e}`);
      return err("خطا در محاسبه کارمزد :" + e, null);
    }
  }

  public async feeApiCalculation(data: PaymentFeeParams) {
    // بهتر است این هم هندل شود اما چون متد داخلی calculatePaymentAmount است
    // فعلا به صورت ساده باقی می‌گذاریم، ولی می‌توان از requestHandler استفاده کرد
    const { data: feeData } = await axios.post(
      `${this.baseURL(false)}/v4/payment/feeCalculation.json`,
      {
        ...data,
        merchant_id: this.merchantId,
      },
    );

    // هندل کردن خطای زرین پال در محاسبه کارمزد
    if (feeData.errors && feeData.errors.length > 0) {
      throw new Error(
        this.zarinpalParser({ response: { data: feeData } }) ||
          "Fee calculation failed",
      );
    }
    const feeAmount = feeData.data.suggested_amount - data.amount;
    return feeAmount;
  }
}
