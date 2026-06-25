"use server";
import { IUserDto } from "@/types/user";
import connectDB from "@lib/db";
import Users from "@models/Users";

// تابعی برای گرفتن اطلاعات
export async function getUserData(_id: string) {
  await connectDB();

  // استفاده از lean() باعث می‌شود آبجکت سبک جاوااسکریپتی برگردد نه داکیومنت سنگین Mongoose
  const user = await Users.findOne({ _id }).lean();

  if (!user) return null;

  // نکته مهم: در Server Component باید _id و Date ها را به استرینگ تبدیل کنی
  // یا اینکه آن‌ها را همانجا فرمت کنی تا ارور Serialization نگیری
  return {
    ...user,
    _id: user._id.toString(),
    createdAt: user.createdAt?.toString(),
    updatedAt: user.updatedAt?.toString(),
  } as unknown as IUserDto;
}
