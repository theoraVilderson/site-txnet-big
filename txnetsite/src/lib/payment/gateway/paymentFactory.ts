// lib/payment/PaymentFactory.ts
import { IPaymentStrategy } from "@/types/payment";
import { ZarinpalProvider } from "./providers/zarinpal";
import { PaymentProvider } from "@/configs/paymentSettings";
import { isDev } from "@/env";
import connectDB from "@lib/db";
import PaymentSettings from "@models/PaymentSettings";

// می‌توانیم اینام بسازیم برای درگاه‌ها

export class PaymentFactory {
  static async getProvider(
    gatewayName: PaymentProvider
  ): Promise<IPaymentStrategy> {
    await connectDB();
    const providerInfo = await PaymentSettings.findOne({
      gatewayName: gatewayName,
    }).select("+merchantId");
    if (!providerInfo) throw new Error("اراعه دهنده پرداخت نامعتبر");
    if (!providerInfo.isActive) throw new Error("درگاه غیر فعال است");

    switch (gatewayName) {
      case PaymentProvider.ZARINPAL:
        return new ZarinpalProvider(
          providerInfo,
          isDev // اگر دولوپ بود سندباکس باشه
        );

      // case "zibal":
      //   return new ZibalProvider(...);

      // case "stripe":
      //   return new StripeProvider(...);

      default:
        throw new Error("اراعه دهنده پرداخت نامعتبر");
    }
  }
}
