import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export const formatPersianDate = (date: string | Date | undefined) => {
  return new Date(!date ? new Date() : date).toLocaleDateString("fa-IR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
};

export const formatPersianTime = (date: string | Date | undefined) => {
  return new Date(!date ? new Date() : date).toLocaleTimeString("fa-IR", {
    hour: "2-digit",
    minute: "2-digit",
  });
};

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const formatCurrency = (value: number | string): string => {
  if (value === "") return "0";
  const num = typeof value === "string" ? parseFloat(value) : value;
  return new Intl.NumberFormat("en-US").format(num);
};

/**
 * A concise helper to convert numbers to Persian words.
 */
export const numberToPersianWords = (num: number): string => {
  if (num === 0) return "صفر";
  if (num < 0) return "منفی " + numberToPersianWords(Math.abs(num));

  const units = ["", "یک", "دو", "سه", "چهار", "پنج", "شش", "هفت", "هشت", "نه"];
  const teens = [
    "ده",
    "یازده",
    "دوازده",
    "سیزده",
    "چهارده",
    "پانزده",
    "شانزده",
    "هفده",
    "هجده",
    "نوزده",
  ];
  const tens = [
    "",
    "",
    "بیست",
    "سی",
    "چهل",
    "پنجاه",
    "شصت",
    "هفتاد",
    "هشتاد",
    "نود",
  ];
  const hundreds = [
    "",
    "صد",
    "دویست",
    "سیصد",
    "چهارصد",
    "پانصد",
    "ششصد",
    "هفتصد",
    "هشتصد",
    "نهصد",
  ];
  const stages = ["", "هزار", "میلیون", "میلیارد"];

  const processThreeDigits = (n: number): string => {
    if (n === 0) return "";
    let res = "";
    const h = Math.floor(n / 100);
    const t = Math.floor((n % 100) / 10);
    const u = n % 10;

    if (h > 0) res += hundreds[h];
    if (t > 0 || u > 0) {
      if (res !== "") res += " و ";
      if (t === 1) {
        res += teens[u];
      } else {
        if (t > 1) res += tens[t];
        if (u > 0) {
          if (t > 1) res += " و ";
          res += units[u];
        }
      }
    }
    return res;
  };

  let result = "";
  let stageIndex = 0;
  let tempNum = num;

  while (tempNum > 0) {
    const section = tempNum % 1000;
    if (section > 0) {
      const sectionWords = processThreeDigits(section);
      const stageName = stages[stageIndex];
      const combined = sectionWords + (stageName ? " " + stageName : "");
      result = combined + (result !== "" ? " و " + result : "");
    }
    tempNum = Math.floor(tempNum / 1000);
    stageIndex++;
  }

  return result.trim() + " تومان";
};
