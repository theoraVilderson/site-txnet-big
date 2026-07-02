export enum TransactionType {
  DEPOSIT = "DEPOSIT",
  PURCHASE = "PURCHASE",
  USAGE_DAILY = "USAGE_DAILY",
}

export enum TransactionDirection {
  IN = "IN",
  OUT = "OUT",
}

export enum TransactionStatus {
  SUCCESS = "SUCCESS",
  PENDING = "PENDING",
  FAILED = "FAILED",
}

export enum TransactionMethod {
  GATEWAY = "GATEWAY", // درگاه بانکی
  WALLET = "WALLET", // کسر از کیف پول
  SYSTEM = "SYSTEM", // سیستمی (مثلا مصرف)
  ADMIN = "ADMIN", // دستی توسط ادمین
}
