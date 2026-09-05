import { PanelNav } from "./_components/PanelNav";

export default function PanelLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="relative flex min-h-screen w-full flex-col transition-colors duration-500">
      <PanelNav />
      <main className="relative z-10 w-full flex-1">{children}</main>
    </div>
  );
}
