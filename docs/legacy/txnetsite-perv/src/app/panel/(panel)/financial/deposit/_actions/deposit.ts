import { IPaymentSettingClient } from "@/types/paymentSetting";
import connectDB from "@lib/db";
import PaymentSettings from "@models/PaymentSettings";

export async function getPaymentSettings() {
  await connectDB();

  // استفاده از lean() باعث می‌شود آبجکت سبک جاوااسکریپتی برگردد نه داکیومنت سنگین Mongoose
  const settings = await PaymentSettings.find({}).lean();
  const serializedData = settings.map((item) => ({
    ...item,
    _id: item._id.toString(), // تبدیل بافر یا آبجکت آیدی به استرینگ
    createdAt: item.createdAt?.toString(),
    updatedAt: item.updatedAt?.toString(), // تبدیل تاریخ به فرمت ایزو
  }));
  // نکته مهم: در Server Component باید _id و Date ها را به استرینگ تبدیل کنی
  // یا اینکه آن‌ها را همانجا فرمت کنی تا ارور Serialization نگیری
  return serializedData as unknown as IPaymentSettingClient[];
}
