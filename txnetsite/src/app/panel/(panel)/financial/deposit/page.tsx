import React from "react";
import DepositPage from "./_components/Deposit";
import { getPaymentSettings } from "./_actions/deposit";
import { PAYMENT_URL } from "@/env";

type Props = {};

async function page({}: Props) {
  const paymentSettings = await getPaymentSettings();
  const paymentBaseURL = PAYMENT_URL;
  return (
    <div>
      <DepositPage
        paymentSettings={paymentSettings}
        paymentBaseURL={paymentBaseURL}
      />
    </div>
  );
}

export default page;
