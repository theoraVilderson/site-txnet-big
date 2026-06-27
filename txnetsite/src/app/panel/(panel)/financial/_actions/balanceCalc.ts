import mongoose, { Types } from "mongoose";
import Transactions from "@/models/Transactions";
import Users from "@/models/Users";
import { TransactionDirection } from "@/configs/transactions";
import { lastRes, LastResType } from "@/shared";
import type {
  ITransactionSchema,
  ITransactionWithBalance,
} from "@/types/transaction";
import { QueryFilter } from "mongoose";
import { parsePersianDate } from "@util/helper";

export function createAdvancedSearchQuery(term: string): RegExp {
  if (!term || term.trim().length === 0) return new RegExp("", "i");
  let pattern = term.trim();
  pattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  pattern = pattern.replace(/\s+/g, "[\\s\\u200c]+");
  const charMap: Record<string, string> = {
    آ: "(آ|ا)",
    ا: "(آ|ا)",
    ی: "(ی|ي|ئ)",
    ي: "(ی|ي|ئ)",
    ک: "(ک|ك)",
    ك: "(ک|ك)",
    ه: "(ه|ة)",
    ة: "(ه|ة)",
  };
  pattern = pattern
    .split("")
    .map((char) => charMap[char] || char)
    .join("");
  return new RegExp(pattern, "i");
}

export interface TransactionFilters {
  search?: string;
  type?: string;
  status?: string;
  startDate?: number;
  endDate?: number;
}

async function calculateSkippedTransactionsChange(
  userId: Types.ObjectId,
  skip: number,
  matchQuery: QueryFilter<ITransactionSchema>
): Promise<number> {
  if (skip === 0) return 0;

  const result = await Transactions.aggregate([
    // [FIX 2]: استفاده از 'as any' یا 'Record<string, any>' برای رفع خطای تایپ Match
    { $match: matchQuery as Record<string, any> },
    { $sort: { createdAt: -1 } },
    { $limit: skip },
    {
      $group: {
        _id: null,
        totalChange: {
          $sum: {
            $cond: [
              { $eq: ["$direction", TransactionDirection.IN] },
              "$amount",
              { $multiply: ["$amount", -1] },
            ],
          },
        },
      },
    },
  ]);

  return result.length > 0 ? result[0].totalChange : 0;
}

export async function getWalletHistory(
  userId: string,
  page: number = 1,
  limit: number = 10,
  filters: TransactionFilters = {}
): Promise<
  // [FIX 1]: تغییر تایپ خروجی به تایپ سریالایز شده
  LastResType<{
    data: ITransactionWithBalance[];
    total: number;
  } | null>
> {
  try {
    if (!Types.ObjectId.isValid(userId)) {
      return lastRes(null, "شناسه کاربر معتبر نیست");
    }
    const userObjectId = new Types.ObjectId(userId);

    const matchQuery: QueryFilter<ITransactionSchema> = {
      user: userObjectId,
    };

    if (filters.type && filters.type !== "ALL") {
      matchQuery.type = filters.type;
    }

    if (filters.status && filters.status !== "ALL") {
      matchQuery.status = filters.status;
    }

    if (filters.search) {
      matchQuery.title = { $regex: createAdvancedSearchQuery(filters.search) };
    }
    const dateQuery: any = {};

    if (filters.startDate || filters.endDate) {
      if (filters.startDate) {
        // تبدیل تاریخ شمسی ورودی به Date میلادی (شروع روز)
        const gregorianStart = parsePersianDate(
          String(filters.startDate),
          false
        );

        if (gregorianStart) {
          (dateQuery as any).$gte = gregorianStart;
        }
      }

      if (filters.endDate) {
        // تبدیل تاریخ شمسی ورودی به Date میلادی (پایان روز)
        const gregorianEnd = parsePersianDate(String(filters.endDate), true);

        if (gregorianEnd) {
          (dateQuery as any).$lte = gregorianEnd;
        }
      }
      // فقط اگر واقعاً شرطی برای تاریخ وجود داشت، آن را به کوئری اضافه کن
      if (Object.keys(dateQuery).length > 0) {
        matchQuery.createdAt = dateQuery;
      }
    }
    const skip = (page - 1) * limit;

    const [user, transactions, totalCount, skippedChange] = await Promise.all([
      Users.findById(userObjectId).select("walletBalance").lean(),
      Transactions.find(matchQuery)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean<ITransactionSchema[]>(),
      Transactions.countDocuments(matchQuery),
      calculateSkippedTransactionsChange(userObjectId, skip, matchQuery),
    ]);

    if (!user) return lastRes(null, "کاربر یافت نشد");

    if (!transactions || transactions.length === 0) {
      return lastRes({ data: [], total: 0 }, "تراکنشی یافت نشد", true);
    }

    let runningBalance = (user.walletBalance || 0) - skippedChange;

    console.log(transactions);
    // اینجا از تایپ جدید استفاده می‌کنیم
    const history: ITransactionWithBalance[] = transactions.map((tx) => {
      const currentLineBalance = runningBalance;

      if (tx.direction === TransactionDirection.IN) {
        runningBalance -= tx.amount;
      } else {
        runningBalance += tx.amount;
      }

      // console.log(tx, "coupen check");
      return {
        ...tx,
        // تبدیل عمیق آرایه‌ها برای حذف کامل پروتوتایپ‌های مانگوس
        couponsCode: tx.couponsCode?.length ? JSON.parse(JSON.stringify(tx.couponsCode)) : undefined,
        usageDetails: tx.usageDetails?.length ? JSON.parse(JSON.stringify(tx.usageDetails)) : undefined,
        
        _id: tx._id.toString(),
        user: tx.user.toString(),
        createdAt: tx.createdAt.toISOString(),
        updatedAt: tx.updatedAt ? tx.updatedAt.toISOString() : "",
        expireAt: tx.expireAt ? tx.expireAt.toISOString() : undefined, // 👈 این هم باید استرینگ شود
        balanceAfter: currentLineBalance,
      };
    });

    return lastRes(
      { data: history, total: totalCount },
      "اطلاعات با موفقیت دریافت شد",
      true
    );
  } catch (error: any) {
    console.error("Error in getWalletHistory:", error);
    return lastRes(null, "خطا در دریافت لیست تراکنش‌ها");
  }
}
