import { AiView } from "./_components/AiView";

/**
 * `/ai` — the tenant's AI page (F-038-j2): settings, discount offers, at-risk
 * customers and the uplift report. A server shell around one client view, like
 * the coupons page; ai answers each tenant its own (`ai.manage`, F-038-j1).
 */
export default function AiPage() {
  return <AiView />;
}
