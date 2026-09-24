import { SystemsView } from "./_components/SystemsView";

/**
 * `/systems` — the platform's panels, for the platform owner's `panel.manage`
 * (F-027-ad, ADR-0080).
 *
 * A server shell around one client view, like the manual payments page.
 * Billing scopes every read and write to the platform's panels
 * (`panelScopeOf`) and refuses anyone else; the view decides nothing about it.
 */
export default function SystemsPage() {
  return <SystemsView />;
}
