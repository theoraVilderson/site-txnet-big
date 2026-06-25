import { getEnv } from "@util/helper";

export const DOMAIN_NAME = getEnv("DOMAIN_NAME");
export const MONGO_DB_USERNAME = getEnv("MONGO_DB_USERNAME");
export const MONGO_DB_PASSWORD = getEnv("MONGO_DB_PASSWORD");
export const MONGO_DB_PORT = getEnv("DB_PORT");
export const REDIS_PASSWORD = getEnv("REDIS_PASSWORD");
export const ENVIRONMENT = getEnv("ENVIRONMENT");
export const isProd = ENVIRONMENT == "prod";
export const isDev = ENVIRONMENT == "dev";
export const mongodb_uri = `mongodb://${MONGO_DB_USERNAME}:${MONGO_DB_PASSWORD}@mongodb:${MONGO_DB_PORT}/txnet_${ENVIRONMENT}?replicaSet=rs0&authSource=admin`;
export const PAYMENT_URL = `${getEnv("NEXT_PUBLIC_PAYMENT_URL")}${
  isDev ? "/outside-payment/dev-txnet" : ""
}`;
export const authSubName = isProd ? "auth" : "devauth";
export const panelSubName = isProd ? "panel" : "devpanel";
export const mainSubName = isProd ? DOMAIN_NAME : "main";
export const paymentSubName = isProd ? "payment" : "paymentd";
export const fullPanelDomain = `${panelSubName}.${DOMAIN_NAME}`;
export const fullAuthDomain = `${authSubName}.${DOMAIN_NAME}`;
export const REDIS_PORT = getEnv("REDIS_PORT");
export const JWT_SECRET = getEnv("JWT_SECRET");
export const JWT_SECRET_CAPTCHA = getEnv("JWT_SECRET_CAPTCHA")!;
export const SMS_USERNAME = getEnv("SMS_USERNAME");
export const SMS_PASS = getEnv("SMS_PASS");
export const SMS_SENDER_PRIVATE = getEnv("SMS_SENDER_PRIVATE");
