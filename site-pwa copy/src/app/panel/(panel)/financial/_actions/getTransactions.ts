"use server";

import connectDB from "@lib/db";
import logger from "@lib/logger";
import { ITransactionWithBalance } from "@/types/transaction";
import DateObject from "react-date-object";
import persian from "react-date-object/calendars/persian";
import persian_fa from "react-date-object/locales/persian_fa";
import { getWalletHistory, TransactionFilters } from "./balanceCalc"; // ایمپورت از فایل ۲
import { getValidatedUser } from "@lib/auth";
import { err, ok } from "@/shared";

// ----------------------------------------------------------------------
// Helper: تبدیل تاریخ شمسی رشته‌ای به Timestamp
// ----------------------------------------------------------------------
const persianToTimestamp = (
  persianDateString: string | undefined,
  endOfDay = false,
) => {
  if (!persianDateString) return undefined;

  const date = new DateObject({
    date: persianDateString,
    format: "YYYY/MM/DD",
    calendar: persian,
    locale: persian_fa,
  });

  // اگر فرمت تاریخ اشتباه باشد، isValid فالس می‌دهد (بسته به کانفیگ react-date-object)
  // اینجا فرض می‌کنیم ورودی معتبر است

  if (endOfDay) {
    date.setHour(23).setMinute(59).setSecond(59);
  } else {
    date.setHour(0).setMinute(0).setSecond(0);
  }

  return date.toDate().getTime();
};

// ----------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------
export interface GetTransactionsResponseType {
  data: ITransactionWithBalance[];
  totalPages: number;
  totalItems: number;
  currentPage: number;
}

// ----------------------------------------------------------------------
// Main Server Action
// ----------------------------------------------------------------------
export async function getTransactions(params: any) {
  try {
    await connectDB();

    const page = Number(params.page) || 1;
    const limit = 10; // می‌توان این را هم از params گرفت

    // ۱. آماده‌سازی فیلترها
    const filters: TransactionFilters = {
      search: params.search, // رشته جستجو
      type: params.type, // نوع (DEPOSIT, USAGE, ...)
      status: params.status, // وضعیت (SUCCESS, FAILED)
      startDate: params.startDate, // تبدیل تاریخ شروع
      endDate: params.endDate, // تبدیل تاریخ پایان (آخر وقت)
    };
    const user = await getValidatedUser();
    if (!user || !user.userId) {
      return err("دسترسی غیرمجاز، لطفا مجددا وارد شوید");
    }
    const { userId } = user;

    // ۲. فراخوانی تابع منطق اصلی
    const result = await getWalletHistory(userId, page, limit, filters);

    // ۳. بررسی خطا
    if (!result.ok || !result.data) {
      return err(result.msg || "خطا در دریافت اطلاعات");
    }

    const { data, total } = result.data;

    // ۴. فرمت خروجی نهایی برای کلاینت
    const response: GetTransactionsResponseType = {
      data: data,
      totalItems: total,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
    };

    return ok(response, "لیست تراکنش‌ها با موفقیت دریافت شد");
  } catch (error) {
    logger.error(`Failed to fetch transactions for user `, error);
    return err("خطای سرور در دریافت تراکنش‌ها");
  }
}
