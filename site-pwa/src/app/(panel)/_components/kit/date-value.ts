import { DateObject } from "react-multi-date-picker";
import gregorian from "react-date-object/calendars/gregorian";
import gregorian_en from "react-date-object/locales/gregorian_en";
import { toEnglishDigits } from "@/util/helper";

/**
 * `DatePicker`'s value and the calendar library's date, both ways (F-093-b,
 * GR-1-k/-l). The value is `YYYY-MM-DD`, or with a time the wall time
 * `YYYY-MM-DDTHH:mm`. The library cannot parse the `T` — a value it read back
 * was invalid, the picker reported "empty", and the field cleared itself
 * right after a pick — so the time is joined by a space on its side only.
 */
const DAY = "YYYY-MM-DD";
const DAY_TIME = "YYYY-MM-DD HH:mm";

/** The value as a Gregorian date the picker can show. */
export function pickerDate(value: string, withTime: boolean): DateObject {
  const date = withTime ? value.replace("T", " ") : value;
  return new DateObject({ date, format: withTime ? DAY_TIME : DAY, calendar: gregorian, locale: gregorian_en });
}

/**
 * A picked date as the value: back to Gregorian, ASCII digits whatever the
 * locale printed. `hadValue` false with a time: a day picked from empty means
 * that day's end, 23:59, which the user may then move.
 */
export function pickedValue(date: DateObject, withTime: boolean, hadValue: boolean): string {
  const picked = new DateObject(date);
  if (withTime && !hadValue) picked.setHour(23).setMinute(59);
  const text = toEnglishDigits(picked.convert(gregorian, gregorian_en).format(withTime ? DAY_TIME : DAY));
  return withTime ? text.replace(" ", "T") : text;
}
