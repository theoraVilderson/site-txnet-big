import mongoose, { Types } from "mongoose";
import Transactions from "@/models/Transactions";
import Users from "@/models/Users";
import { TransactionDirection } from "@/configs/transactions";
import type {
  ITransactionSchema,
  ITransactionWithBalance,
} from "@/types/transaction";
import { QueryFilter } from "mongoose";
import { parsePersianDate, zodErrorToString } from "@util/helper";
import { getWalletHistorySchema } from "@lib/validations";
import { err, ok } from "@/shared";

export function createAdvancedSearchQuery(term: string): RegExp {
  if (!term || term.trim().length === 0) return new RegExp("", "i");

  let pattern = term.trim();

  // ۱. خنثی‌سازی کاراکترهای خاص
  pattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // ۲. مدیریت یکپارچه فاصله‌ها و نیم‌فاصله‌ها
  // ابتدا اگر کاربر خودش نیم‌فاصله تایپ کرده بود، آن را به فاصله تبدیل می‌کنیم
  pattern = pattern.replace(/\u200c/g, " ");
  // سپس تمام فاصله‌ها را به پترن "فاصله یا نیم‌فاصله" تبدیل می‌کنیم
  pattern = pattern.replace(/\s+/g, "[\\s\\u200c]+");

  // ۳. نگاشت حروف به صورت جامع (دوطرفه و کامل)
  const charMap: Record<string, string> = {
    آ: "(آ|ا)",
    ا: "(آ|ا)",
    ی: "(ی|ي|ئ|ى)",
    ي: "(ی|ي|ئ|ى)",
    ئ: "(ی|ي|ئ|ى)", // اضافه شدن حالت معکوس و الف مقصوره (ى)
    ى: "(ی|ي|ئ|ى)",
    ک: "(ک|ك)",
    ك: "(ک|ك)",
    ه: "(ه|ة)",
    ة: "(ه|ة)",
  };

  // استفاده از متد replace به جای split.map.join (بهینه‌تر و اصولی‌تر)
  pattern = pattern.replace(/[آااییئىکكهة]/g, (match) => charMap[match]);

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
  matchQuery: QueryFilter<ITransactionSchema>,
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

// get wallet info like incoming outgoing or spending money
export async function getWalletHistory(
  userId: string,
  page: number = 1,
  limit: number = 10,
  filters: TransactionFilters = {},
) {
  try {
    // Validate Zod
    const validation = getWalletHistorySchema.safeParse({
      userId,
      page,
      limit,
      filters,
    });
    if (!validation.success) {
      return err(zodErrorToString(validation.error));
    }

    const { filters: vfilters, userId: vuserId } = validation.data;
    const userObjectId = new Types.ObjectId(vuserId);
    const matchQuery: QueryFilter<ITransactionSchema> = {
      // user here is the user id
      user: userObjectId,
    };
    if (vfilters?.type && vfilters?.type !== "ALL") {
      matchQuery.type = vfilters?.type;
    }

    if (vfilters?.status && vfilters?.status !== "ALL") {
      matchQuery.status = vfilters?.status;
    }

    if (vfilters?.search) {
      matchQuery.title = {
        $regex: createAdvancedSearchQuery(vfilters?.search),
      };
    }
    const dateQuery: any = {};

    if (vfilters?.startDate || vfilters?.endDate) {
      if (vfilters?.startDate) {
        // تبدیل تاریخ شمسی ورودی به Date میلادی (شروع روز)
        const gregorianStart = parsePersianDate(
          String(vfilters?.startDate),
          false,
        );

        if (gregorianStart) {
          (dateQuery as any).$gte = gregorianStart;
        }
      }

      if (vfilters?.endDate) {
        // تبدیل تاریخ شمسی ورودی به Date میلادی (پایان روز)
        const gregorianEnd = parsePersianDate(String(vfilters?.endDate), true);

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

    if (!user) return err("کاربر یافت نشد");

    if (!transactions || transactions.length === 0) {
      return ok({ data: [], total: 0 }, "تراکنشی یافت نشد");
    }

    let runningBalance = (user.walletBalance || 0) - skippedChange;

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
        couponsCode: tx.couponsCode?.length
          ? JSON.parse(JSON.stringify(tx.couponsCode))
          : undefined,
        usageDetails: tx.usageDetails?.length
          ? JSON.parse(JSON.stringify(tx.usageDetails))
          : undefined,

        _id: tx._id.toString(),
        user: tx.user.toString(),
        createdAt: tx.createdAt.toISOString(),
        updatedAt: tx.updatedAt ? tx.updatedAt.toISOString() : "",
        expireAt: tx.expireAt ? tx.expireAt.toISOString() : undefined, // 👈 این هم باید استرینگ شود
        balanceAfter: currentLineBalance,
      };
    });

    return ok(
      { data: history, total: totalCount },
      "اطلاعات با موفقیت دریافت شد",
    );
  } catch (error: any) {
    console.error("Error in getWalletHistory:", error);
    return err("خطا در دریافت لیست تراکنش‌ها");
  }
}
