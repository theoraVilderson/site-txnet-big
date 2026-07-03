import { PaymentProvider } from "@/configs/paymentSettings";

export interface Gateway {
  gatewayName: PaymentProvider;
  displayName: string;
  logo: string;
  color: string;
}

export interface PresetAmount {
  value: number;
}

export interface CouponValidationResult {
  isValid: boolean;
  discountAmount?: number;
  description?: string;
  error?: string;
}

export enum PaymentStatus {
  IDLE = "idle",
  LOADING = "loading",
  SUCCESS = "success",
  ERROR = "error",
}
