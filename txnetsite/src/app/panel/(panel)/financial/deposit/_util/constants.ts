import { PaymentProvider } from "@/configs/paymentSettings";
import { Gateway } from "../_types/type";

export const PRESET_AMOUNTS = [
  196000, 392000, 588000, 784000, 1000000, 2000000,
];
export const SLIDER_MAX_AMOUNT = 2000000; // Slider limit set to 2M as requested

export const GATEWAYS: Gateway[] = [
  {
    gatewayName: PaymentProvider.ZARINPAL,
    displayName: "زرین‌پال",
    logo: "Z",
    color: "bg-yellow-400",
  },
  // {
  //   gatewayName: "mellat",
  //   displayName: "بانک ملت",
  //   logo: "M",
  //   color: "bg-red-600",
  // },
  // {
  //   gatewayName: "saman",
  //   displayName: "سامان کیش",
  //   logo: "S",
  //   color: "bg-blue-600",
  // },
];
