import { Types, Document } from "mongoose";
import {
  TransactionDirection,
  TransactionMethod,
  TransactionStatus,
  TransactionType,
} from "@/configs/transactions";
import { IAppliedCoupon } from "./coupons";

// 1. Base Entity: دیتای خالص که در فرانت‌اند و بک‌اند مشترک است (بدون وابستگی به مانگوس)
// همه چیز string است تا برای JSON شدن آماده باشد.
export interface ITransactionBase {
  type: TransactionType;
  direction: TransactionDirection;
  status: TransactionStatus;
  method: TransactionMethod;
  amount: number;
  title: string;
  authority?: string;
  refId?: string;
  gatewayName?: string;
  feeAmount?: number;
  taxAmount?: number;
  usageDetails?: IUsageDetail[];
  couponsCode?: IAppliedCoupon[]; // کد تخفیف استفاده شده
  discountAmount?: number; // مبلغی که کسر شد
}

export interface IUsageDetail {
  serviceId: string;
  cost: number;
  timestamp: string; // اصلاح شد: چون در JSON همیشه استرینگ است
  reason: string;
  couponsCode?: IAppliedCoupon[]; // کد تخفیف استفاده شده
  discountAmount?: number; // مبلغی که کسر شد
}

// 2. Database Model: چیزی که در دیتابیس ذخیره می‌شود (Mongoose Specific)
export interface ITransactionSchema extends ITransactionBase {
  _id: Types.ObjectId;
  user: Types.ObjectId; // در دیتابیس رفنس است
  createdAt: Date;
  updatedAt: Date;
  expireAt?: Date;
}

// 3. API Response / Frontend Type: چیزی که کلاینت دریافت می‌کند
export interface ITransactionDto extends ITransactionBase {
  _id: string;
  user: string; // در فرانت‌اند یوزر معمولا فقط آی‌دی یا یک آبجکت populated شده است
  createdAt: string; // تاریخ‌ها در API معمولا ISO String هستند
  updatedAt: string;
}

// تایپ بالانس که اکستند شده
export interface ITransactionWithBalance extends ITransactionDto {
  balanceAfter: number;
}

// تایپ صفحه‌بندی جنریک
export interface PaginatedResponse<T> {
  data: T[];
  totalPages: number;
  currentPage: number;
  totalItems: number;
}
