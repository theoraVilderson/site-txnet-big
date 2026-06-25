import "server-only";
import { createLogger, format, transports } from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import path from "path";

const logDir = path.join(process.cwd(), "logs");
const env = process.env.NODE_ENV || "development";

const devTransport = new DailyRotateFile({
  filename: path.join(logDir, "dev", "dev-%DATE%.log"),
  datePattern: "YYYY-MM-DD-HH-mm-ss",
  zippedArchive: false,
  maxSize: "10k", // حدود 100 لاگ در هر فایل
  maxFiles: "3",
});

const prodTransport = new DailyRotateFile({
  filename: path.join(logDir, "prod", "prod-%DATE%.log"),
  datePattern: "YYYY-MM-DD-HH-mm-ss",
  zippedArchive: false,
  maxSize: "10k",
  maxFiles: "3",
});

const logger = createLogger({
  level: env === "development" ? "debug" : "info", // dev: همه لاگ‌ها، prod: فقط info و بالاتر
  format: format.combine(
    format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    format.printf(
      (info) =>
        `${info.timestamp} [${info.level.toUpperCase()}]: ${info.message}`
    )
  ),
  transports: [
    ...(env === "development"
      ? [devTransport, new transports.Console()]
      : [prodTransport]),
  ],
});

export default logger;
