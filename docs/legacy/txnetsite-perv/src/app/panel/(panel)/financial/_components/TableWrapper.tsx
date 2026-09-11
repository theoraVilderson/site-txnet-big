"use client";

import React from "react";
import { useLoading } from "../_context/LoadingContext";
import { TableSkeleton } from "./TableSkeleton";

export function TableWrapper({ children }: { children: React.ReactNode }) {
  const { isLoading } = useLoading();

  if (isLoading) {
    return <TableSkeleton />;
  }

  return <>{children}</>;
}
