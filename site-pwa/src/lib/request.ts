import { err, ok, type ResponseType } from "@/shared";
import axios from "axios";
import { toast } from "react-hot-toast";

export const apiReq = axios.create({
  baseURL: "/api",
  withCredentials: true,
});
export const req = axios.create({
  withCredentials: true,
  headers: {
    "Content-Type": "application/json",
  },
});

export function handleAxiosError(
  error: unknown,
  defaultMsg = "خطای ناشناخته‌ای رخ داد",
  takeAction = true,
) {
  let message = defaultMsg;
  let status: number | undefined;

  if (axios.isAxiosError(error)) {
    status = error.response?.status;

    // ✅ اگر سرور msg فرستاده باشد
    if (error.response?.data?.msg) {
      message = error.response.data.msg;
    }

    // ✅ اگر msg نبود ولی error استاندارد بود
    else if (error.message) {
      message = error.message;
    }

    // ✅ اگر نه msg بود نه message
    else {
      message = "خطای نامشخص از سمت سرور";
    }

    // ✅ لاگ حرفه‌ای برای دیباگ
    takeAction &&
      console.error("AXIOS ERROR:", {
        status,
        data: error.response?.data,
        url: error.config?.url,
        method: error.config?.method,
      });
  }

  // ✅ اگر اصلاً Axios Error نبود
  else {
    takeAction && console.error("UNKNOWN ERROR:", error);
    message = "خطای غیرمنتظره‌ای رخ داد";
  }

  console.log("h222");
  // ✅ نمایش به کاربر
  takeAction && toast.error(message);

  return { message, status };
}

// 1. تعریف یک تایپ برای تابع مفسر خطا
// این تابع خطا را می‌گیرد و یک پیام متنی برمی‌گرداند (یا null اگر نتواند خطا را بفهمد)
export type ErrorParser = (error: unknown) => string | undefined;

interface RequestHandlerOptions {
  maxRetries?: number;
  retryDelayMs?: number; // امکان شخصی‌سازی زمان تاخیر بین تلاش‌ها
  errorParser?: ErrorParser;
  defaultErrorMessage?: string;
}

export async function requestHandler<T>(
  action: () => Promise<T | ResponseType<T>> | T | ResponseType<T>, // حتماً باید فانکشن باشد
  options: RequestHandlerOptions = {}, // آپشن‌ها به عنوان پارامتر دوم (اختیاری)
): Promise<ResponseType<T>> {
  const {
    maxRetries = 3,
    retryDelayMs = 1000,
    errorParser,
    defaultErrorMessage = "خطا در برقراری ارتباط با درگاه",
  } = options;

  // استفاده از حلقه for برای کنترل تمیزتر تلاش‌ها
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // اجرا کردن اکشن
      const result = await action();

      // بررسی اینکه آیا خروجی از نوع ResponseType است یا خیر
      if (result && typeof result === "object" && "ok" in result) {
        return result as ResponseType<T>;
      }

      return ok(result);
    } catch (error: unknown) {
      // لاگ کردن خطا با بررسی نوع
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(`Attempt ${attempt + 1} failed:`, errorMessage);

      // اگر هنوز فرصت تلاش باقی است، صبر کن و حلقه را ادامه بده
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, retryDelayMs));
        continue;
      }

      // --------------------------------------------------
      // مدیریت خطا پس از پایان تمام تلاش‌ها
      // --------------------------------------------------
      let finalMsg = defaultErrorMessage;

      if (errorParser) {
        const parsedMsg = errorParser(error);
        if (parsedMsg) {
          finalMsg = parsedMsg;
        }
      } else if (error instanceof Error && error.message) {
        // خواندن پیام از آبجکت استاندارد Error
        finalMsg = error.message;
      }

      return err(finalMsg);
    }
  }

  // این خط در حالت عادی اجرا نمی‌شود، اما برای جلوگیری از خطای تایپ‌اسکریپت نیاز است
  return err("Unexpected Error");
}
