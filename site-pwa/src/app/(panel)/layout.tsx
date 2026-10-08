import { ConfirmProvider } from "./_components/kit/confirm";
import { PanelToaster } from "./_components/kit/notify";
import { PanelMotion } from "./_components/PanelMotion";
import { PanelPreferences } from "./_components/PanelPreferences";
import { PanelShell } from "./_components/PanelShell";
import { PaymentCreditedToast } from "./_components/PaymentCreditedToast";
import { TenantClosedBanner } from "./_components/TenantClosedBanner";
import { PanelRealtimeProvider } from "./_context/PanelRealtimeContext";
import { PanelSessionProvider } from "./_context/PanelSessionContext";
import { ResellerWorkspaceProvider } from "./_context/ResellerWorkspaceContext";

export default function PanelLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // Every panel screen needs to know who it is signed in as, and the nav's
    // switcher needs it before the page below it renders — so the session sits
    // at the layout, not inside a page.
    <PanelSessionProvider>
      {/*
        Inside the session, because the socket's credential is the access token
        that provider establishes — and at the layout, because that is what
        makes one connection outlive every screen under it (F-070-c).
      */}
      <PanelRealtimeProvider>
      {/*
        UX-2-a2: whose reseller the page is, decided once for the menu and every
        header. Inside the socket: its setup row re-reads on a live event (UX-2-e).
      */}
      <ResellerWorkspaceProvider>
        {/* UX-1-l: the person's display preferences, loaded once `me` is known. */}
        <PanelPreferences />
        {/* UX-1-b: one motion level for framer-motion and the CSS below it. */}
        <PanelMotion>
          {/* UX-1-d: one `useConfirm` dialog for every panel screen (K9). */}
          <ConfirmProvider>
            <PanelShell>{children}</PanelShell>
          </ConfirmProvider>
        </PanelMotion>
        {/* UX-1-e: where every `notify.*` toast is drawn (K10). */}
        <PanelToaster />
        {/* F-067-l: a late credit is announced on any screen (ADR-0045). */}
        <PaymentCreditedToast />
        {/* F-018-ac: the gateway closed the socket because the tenant is terminated. */}
        <TenantClosedBanner />
      </ResellerWorkspaceProvider>
      </PanelRealtimeProvider>
    </PanelSessionProvider>
  );
}
