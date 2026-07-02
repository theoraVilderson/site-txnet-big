"use client";

import React from "react";
import { CreditCard } from "lucide-react";
import { GATEWAYS } from "../_util/constants";
import { IPaymentSettingClient } from "@/types/paymentSetting";
import { PaymentProvider } from "@/configs/paymentSettings";

interface GatewaySelectorProps {
  selectedGateway: "" | PaymentProvider;
  onSelect: (id: "" | PaymentProvider) => void;
  gateways: IPaymentSettingClient[];
}

const GatewaySelector: React.FC<GatewaySelectorProps> = ({
  selectedGateway,
  onSelect,
  gateways,
}) => {
  const allgatewayName = gateways.map((e) => e.gatewayName);
  const filterdGateway = GATEWAYS.filter((e) =>
    allgatewayName.includes((e as any).gatewayName)
  );
  return (
    <div className="w-full">
      <h3 className="text-sm font-bold text-[var(--text-primary)] mb-4 flex items-center gap-2 px-1">
        <CreditCard size={18} className="text-[var(--accent-primary)]" />
        انتخاب درگاه پرداخت
      </h3>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-2  gap-3">
        {filterdGateway.map((gw) => (
          <div
            key={gw.gatewayName}
            onClick={() => onSelect(gw.gatewayName)}
            className={`
              cursor-pointer p-3 sm:p-4 rounded-2xl border flex flex-col sm:flex-row items-center gap-2 sm:gap-3 transition-all duration-300
              ${
                selectedGateway === gw.gatewayName
                  ? "border-[var(--accent-primary)] bg-[var(--leaf-bg)] ring-2 ring-[var(--accent-primary)] shadow-sm scale-[1.02]"
                  : "border-[var(--card-border)] bg-[var(--card-bg)] hover:border-[var(--text-secondary)] hover:bg-[var(--bg-inner)]"
              }
            `}
          >
            <div
              className={`w-8 h-8 sm:w-10 sm:h-10 rounded-full flex items-center justify-center text-white font-bold shadow-md shrink-0 ${gw.color}`}
            >
              {gw.logo}
            </div>
            <span className="text-xs sm:text-sm font-bold text-[var(--text-primary)] text-center sm:text-right">
              {gw.displayName}
            </span>
            {selectedGateway === gw.gatewayName && (
              <div className="hidden sm:block mr-auto w-2 h-2 rounded-full bg-[var(--accent-primary)] animate-pulse" />
            )}
            {selectedGateway === gw.gatewayName && (
              <div className="sm:hidden mt-1 w-1.5 h-1.5 rounded-full bg-[var(--accent-primary)] animate-pulse" />
            )}
          </div>
        ))}
      </div>
      {!filterdGateway.length && (
        <p
          className={`text-[var(--error-color)] text-[10px] sm:text-[15px] md:text-[20px] leading-relaxed font-black`}
        >
          درگاهی ثبت نشده سیستم غیر فعال است!
        </p>
      )}
    </div>
  );
};

export default GatewaySelector;
