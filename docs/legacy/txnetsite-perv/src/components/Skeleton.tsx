"use client";

import React from "react";
import { Skeleton, SkeletonProps } from "@mui/material";
import { styled } from "@mui/material/styles";

// 1. تعریف استایل‌ها با پشتیبانی از تم
const StyledSkeleton = styled(Skeleton)(() => ({
  backgroundColor: "var(--skeleton-bg)", // خواندن از متغیر CSS
  borderRadius: "20px", // گوشه‌های نرم و ارگانیک

  // تنظیم انیمیشن موج (Wave) کاستوم
  "&::after": {
    background: "var(--skeleton-wave)",
  },

  // جلوگیری از باگ تغییر سایز خودکار MUI
  transform: "scale(1, 1)",

  // اگر نوع دایره‌ای بود، گردی کامل شود (override کردن ۲۰ پیکسل)
  "&.MuiSkeleton-circular": {
    borderRadius: "50%",
  },

  // حذف رنگ طوسی پیش‌فرض در دارک مود اگر وجود داشت
  "&.MuiSkeleton-wave": {
    // تنظیمات اضافی در صورت نیاز
  },
}));

// 2. تعریف اینترفیس (اختیاری: اگر بخواهید پراپ‌های اضافه داشته باشید)
// ما اینجا تمام پراپ‌های استاندارد Skeleton را ارث‌بری می‌کنیم
interface NatureSkeletonProps extends SkeletonProps {
  // اگر در آینده پراپ خاصی خواستید اضافه کنید، اینجا بنویسید
}

const NatureSkeleton: React.FC<NatureSkeletonProps> = ({
  variant = "rounded", // پیش‌فرض روی گرد (Rounded)
  animation = "wave", // انیمیشن همیشه موج باشد چون طبیعی‌تر است
  className,
  ...props
}) => {
  return (
    <StyledSkeleton
      variant={variant}
      animation={animation}
      className={className}
      {...props}
    />
  );
};
export function CaptchaSkeleten() {
  return (
    <NatureSkeleton
      sx={{ backgroundColor: "var(--skeleton-bg)", height: "50px" }}
    />
  );
}
export default NatureSkeleton;
