import { lastRes, LastResType } from "@/shared";
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
  takeAction = true
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
export type ErrorParser = (error: any) => string | undefined | null;

export async function requestHandler<T>(
  options: {
    maxRetries?: number;
    errorParser?: ErrorParser; // تابع اختصاصی برای تفسیر خطای درگاه
    defaultErrorMessage?: string;
  } = {},
  action: () => Promise<LastResType<T>>
): Promise<LastResType<T | null>> {
  const {
    maxRetries = 3,
    errorParser,
    defaultErrorMessage = "خطا در برقراری ارتباط با درگاه",
  } = options;

  let attempts = 0;

  while (attempts <= maxRetries) {
    try {
      // اجرای اکشن
      return await action();
    } catch (error: any) {
      attempts++;
      // لاگ کردن خطا (بهتر است خطا را کامل لاگ کنید)
      console.error(`Attempt ${attempts} failed:`, error?.message || error);

      // اگر هنوز فرصت تلاش باقی است
      if (attempts <= maxRetries) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }

      // --------------------------------------------------
      // مدیریت خطا پس از پایان تلاش‌ها (بخش جنریک شده)
      // --------------------------------------------------

      let finalMsg = defaultErrorMessage;

      // 1. اگر مفسر خطا پاس داده شده باشد، سعی می‌کنیم پیام خطا را از آن بگیریم
      if (errorParser) {
        const parsedMsg = errorParser(error);
        if (parsedMsg) {
          finalMsg = parsedMsg;
        }
      }
      // 2. اگر مفسر نبود یا پیامی نداد، پیام پیش‌فرض خودِ ارور را چک می‌کنیم
      else if (error?.message) {
        finalMsg = error.message;
      }

      return lastRes(null, finalMsg, false);
    }
  }

  return lastRes(null, "Unexpected Error", false);
}
