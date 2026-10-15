import { TransferPayView } from "../_components/TransferPayView";

/**
 * `/payment/transfer/[paymentId]` — where a manual top-up is paid (F-803-i):
 * the deposit picker sends the payer here on start (F-803-h,
 * `paymentTransferPath`). Billing answers only the payment's owner, so the
 * view shows "not found" to anyone else; the page checks nothing itself.
 */
export default async function PaymentTransferPage({ params }: { params: Promise<{ paymentId: string }> }) {
  const { paymentId } = await params;
  return <TransferPayView paymentId={paymentId} />;
}
