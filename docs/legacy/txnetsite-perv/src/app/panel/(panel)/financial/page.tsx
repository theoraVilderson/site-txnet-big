// app/finance/page.tsx
import React, { Suspense } from "react";
import { FinancialTable } from "./_components/FinancialTable";
import { Pagination } from "./_components/Pagination";
import { AdvancedFilter } from "./_components/AdvancedFilter";
import {
  getTransactions,
  GetTransactionsResponseType,
} from "./_actions/getTransactions";
import { TableSkeleton } from "./_components/TableSkeleton"; // ایمپورت اسکلتون
import { Wallet } from "lucide-react";
import { LoadingProvider } from "./_context/LoadingContext";
import { TableWrapper } from "./_components/TableWrapper";
import { getValidatedUser } from "@lib/auth";
import { fullAuthDomain } from "@/env";
import { redirect } from "next/navigation";

// این کامپوننت را جدا می‌کنیم تا بتوانیم رویش Suspense بگذاریم
async function TransactionList({ searchParams }: { searchParams: any }) {
  const userTokenData = await getValidatedUser();
  if (!userTokenData) {
    const redirectUrl = new URL(
      `/login`,
      `https://${fullAuthDomain}`
    ).toString();
    redirect(redirectUrl);
    return null;
  }
  const tsRes = await getTransactions(searchParams, userTokenData.userId);

  if (tsRes.failed) {
    return (
      <>
        <FinancialTable transactions={[]} />
        <Pagination
          currentPage={0}
          totalPages={0}
          totalItems={0}
          itemsPerPage={10}
        />
      </>
    );
  }
  const { data, totalPages, currentPage, totalItems } = tsRes.data!;
  // data.forEach((e) => {
  //   if (e.couponsCode) {
  //     e.couponsCode = e.couponsCode.map((e) => {
  //       return {
  //         ...e,
  //         id: e.id.toString(),
  //         description: e.description ?? "",
  //       };
  //     });
  //   }
  // });
  // console.log(tsRes.data);
  return (
    <>
      <FinancialTable transactions={data} />
      <Pagination
        currentPage={currentPage}
        totalPages={totalPages}
        totalItems={totalItems}
        itemsPerPage={10}
      />
    </>
  );
}
type Params = Promise<{ [key: string]: string | string[] | undefined }>;
export default async function FinancePage({
  searchParams,
}: {
  searchParams: Params;
}) {
  // ساختن یک کلید منحصر به فرد بر اساس پارامترها
  // هر وقت صفحه یا فیلتر عوض شود، این کلید عوض می‌شود و Suspense فعال می‌شود
  const param = await searchParams;
  const suspenseKey = JSON.stringify(param);

  return (
    <LoadingProvider>
      {" "}
      {/* ۱. کل صفحه را در پرووایدر می‌گذاریم */}
      <div className="min-h-screen p-4 md:p-8 max-w-7xl mx-auto space-y-6">
        {/* Header & Stats ... (کدهای قبلی) */}
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold text-[var(--text-primary)] flex items-center gap-3">
              <span className="p-2 bg-[var(--accent-primary)] text-white rounded-xl shadow-lg shadow-[var(--accent-glow)]">
                <Wallet size={24} />
              </span>
              امور مالی
            </h1>
          </div>
        </div>

        <AdvancedFilter />

        {/* 
         جادوی کار اینجاست: 
         با تغییر suspenseKey، ریاکت کامپوننت داخلی را نابود و دوباره می‌سازد.
         در این فاصله، fallback (اسکلتون) نمایش داده می‌شود.
      */}
        <TableWrapper>
          <Suspense key={suspenseKey} fallback={<TableSkeleton />}>
            <TransactionList searchParams={param} />
          </Suspense>
        </TableWrapper>
      </div>
    </LoadingProvider>
  );
}
