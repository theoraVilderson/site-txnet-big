"use client";

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  ReactNode,
} from "react";
import { useSearchParams } from "next/navigation";

interface LoadingContextType {
  isLoading: boolean;
  startLoading: () => void;
}

const LoadingContext = createContext<LoadingContextType>({
  isLoading: false,
  startLoading: () => {},
});

export function LoadingProvider({ children }: { children: ReactNode }) {
  const [isLoading, setIsLoading] = useState(false);
  const searchParams = useSearchParams();

  // هر وقت URL عوض شد (یعنی دیتا از سرور رسید)، لودینگ را خاموش کن
  useEffect(() => {
    setIsLoading(false);
  }, [searchParams]);

  const startLoading = () => {
    setIsLoading(true);
  };

  return (
    <LoadingContext.Provider value={{ isLoading, startLoading }}>
      {children}
    </LoadingContext.Provider>
  );
}

export const useLoading = () => useContext(LoadingContext);
