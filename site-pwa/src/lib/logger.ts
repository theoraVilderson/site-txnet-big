import "server-only";
import { isDev } from "@/env";
import winston from "winston";

const { combine, timestamp, json, colorize, printf, errors } = winston.format;

// ۱. فرمت برای محیط توسعه (خوانا و رنگی)
const devFormat = combine(
  colorize(),
  timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  printf(({ level, message, timestamp, stack }) => {
    return `${timestamp} [${level}]: ${stack || message}`;
  })
);

// ۲. فرمت برای پروداکشن (JSON استاندارد برای داکر و الستیک)
const prodFormat = combine(timestamp(), errors({ stack: true }), json());

const logger = winston.createLogger({
  level: isDev ? "debug" : "info", // dev: همه لاگ‌ها، prod: فقط info و بالاتر
  format: isDev ? devFormat : prodFormat,
  transports: [new winston.transports.Console()],
  exitOnError: false,
});

export default logger;
