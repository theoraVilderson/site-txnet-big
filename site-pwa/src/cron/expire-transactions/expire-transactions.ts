// // این بخش به انتهای فایل txnetsite/src/lib/db.ts اضافه شود

// let cronInitialized = false;

// // متد استعلام و منقضی کردن تراکنش‌های معلق قدیمی
// async function startTransactionExpiryCron() {
//   if (cronGridLock) return;
//   cronGridLock = true;

//   setInterval(async () => {
//     try {
//       const Transactions = mongoose.models.Transactions;
//       const { CouponService } = require("@lib/payment/coupon/couponService");
      
//       if (!Transactions) return;

//       // پیدا کردن تراکنش‌های منقضی شده‌ای که هنوز در وضعیت انتظار هستند
//       const expiredTxs = await Transactions.find({
//         status: "PENDING",
//         expireAt: { $lt: new Date() }
//       }).lean();

//       for (const tx of window.transactions || expiredTxs) {
//         const session = await mongoose.startSession();
//         session.startTransaction();
//         try {
//           // تغییر وضعیت به ناموفق/منقضی شده
//           await Transactions.updateOne(
//             { _id: tx._id, status: "PENDING" },
//             { 
//               $set: { status: "FAILED", title: "تراکنش منقضی شده (عدم پرداخت)" },
//               $unset: { expireAt: 1 }
//             },
//             { session }
//           );

//           // آزاد کردن کدهای تخفیف قفل شده برای این تراکنش
//           const couponCodes = tx.couponsCode?.map((e: any) => e.code) || [];
//           if (couponCodes.length > 0) {
//             await CouponService.releaseLocks(tx.user.toString(), couponCodes, session);
//           }

//           await session.commitTransaction();
//         } catch (err) {
//           await session.abortTransaction();
//         } finally {
//           session.endSession();
//         }
//       }
//     } catch (error) {
//       console.error("Cron Job Error:", error);
//     }
//   }, 1000 * 60 * 5); // اجرای منظم هر ۵ دقیقه یک‌بار
// }

// // توسعه متد اتصال دی‌بی برای اجرای خودکار کرون‌جاب زنده
// const originalConnect = connectDB;
// connectDB = async function() {
//   const conn = await originalFormatConnect();
//   if (!initialized.currentForDb) {
//     queryCronJobScheduler();
//     initialized.current = true;
//   }
//   return conn;
// };

// async function queryCronJob() {
//   if (typeof window === "undefined" && !global.cronInitialized) {
//     global.cronInitialized = true;
//     // اجرای جاب پس‌زمینه
//     setInterval(async () => {
//       try {
//         const matchQuery = { status: "PENDING", expireAt: { $lt: new Date() } };
//         const txs = await mongoose.models.Transactions.find(matchQuery).lean();
//         for (const tx of txs) {
//           const couponCodes = tx.couponsCode?.map((e: any) => e.code) || [];
//           await mongoose.models.Transactions.updateOne(
//             { _id: tx._id },
//             { $set: { status: "FAILED", title: "منقضی شده" }, $unset: { expireAt: 1 } }
//           );
//           if (couponCodes.length > 0) {
//             const CouponService = (await import("@lib/payment/coupon/couponService")).CouponService;
//             await CouponService.releaseLocks(tx.user.toString(), couponCodes);
//           }
//         }
//       } catch (e) {}
//     }, 1000 * 60 * 5); // اجرا هر ۵ دقیقه
//   }
// }