import { PanelShell } from "./_components/PanelShell";
import { PanelRealtimeProvider } from "./_context/PanelRealtimeContext";
import { PanelSessionProvider } from "./_context/PanelSessionContext";

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
        <PanelShell>{children}</PanelShell>
      </PanelRealtimeProvider>
    </PanelSessionProvider>
  );
}
