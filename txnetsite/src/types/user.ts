/**
 * User Interface
 */

import { Types } from "mongoose";
import { Permissions } from "./permission";

export enum IUserStatus {
  ACTIVE = "ACTIVE",
  INACTIVE = "INACTIVE",
  BLOCKED = "BLOCKED",
}

export enum UserRoles {
  USER = "USER", // کاربر عادی (خرید و تمدید)
  VIP = "VIP", // کاربر ویژه (دسترسی به سرورهای خاص)
  SUPPORT = "SUPPORT", // پشتیبان (مشاهده تیکت‌ها و وضعیت کاربران)
  AGENT = "AGENT", // نماینده فروش (دارای پنل همکاری در فروش)
  MANAGER = "MANAGER", // مدیر عملیاتی (مدیریت سرورها و قیمت‌ها)
  ADMIN = "ADMIN", // مدیر کل (دسترسی مطلق به دیتابیس و تنظیمات سیستمی)
}
export interface IUserBase {
  fullName: string;
  phone: string;
  telegramID: string;
  walletBalance: number;
  roles: UserRoles[];
  permissions: Permissions[];
  status: IUserStatus;
}

export interface IUserSchema extends IUserBase {
  createdAt: Date;
  updatedAt: Date;
  _id: Types.ObjectId;
}
export interface IUserDto extends IUserBase {
  createdAt: String;
  updatedAt: String;
  _id: string;
}
