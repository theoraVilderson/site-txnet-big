import { fullPanelDomain } from "@/env";
import PaymentSuccessPage from "./_components/PaymentSuccessPage";

export default async function page() {
  const panelURL = `https://${fullPanelDomain}`;

  return <PaymentSuccessPage panelURL={panelURL} />;
}
