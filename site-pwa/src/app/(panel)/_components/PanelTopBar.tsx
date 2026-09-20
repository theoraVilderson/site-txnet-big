"use client";

import { Menu } from "lucide-react";
import { LangDropdown } from "@auth/auth/_components/LangDropdown";
import { ThemeDropdown } from "@auth/auth/_components/ThemeDropdown";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { usePanelUiStore } from "../_stores/panel-ui-store";
import { AccountSwitcher } from "./AccountSwitcher";
import { NotificationsButton } from "./NotificationsButton";
import { PANEL_SIDEBAR_ID } from "./PanelSidebar";
import { WalletButton } from "./WalletButton";

/** The shell's strings as generated constants (C-06). */
const S = FrontendI18nKeys.common.shell;

const Divider = ({ className = "" }: { className?: string }) => (
  <div className={`mx-1 h-6 w-px bg-card-border ${className}`} />
);

/**
 * The panel's top bar (F-093-a). It keeps what the old flat nav held — the
 * account switcher, language, theme and logout — and gains the button that
 * opens the sidebar drawer below `lg`. There is no profile menu: the account
 * switcher is that job (F-0209). Below `sm`, language and theme move into the
 * drawer, because the bar has no room for four controls on a phone.
 *
 * `WalletButton` (F-093-c) and `NotificationsButton` (F-093-h) sit before the
 * switcher, which is where `contract.shell.md` rule 5 puts a new control. The
 * bell is what made the wallet collapse to its icon below `sm`: measured at
 * 360px the bar has 304px of content box and held ~286px, and a `p-2` bell is
 * 40px with the row's gap. Moving the balance into the wallet's own dropdown
 * gives back ~110px, so the phone row is ~220px — with room for the control
 * after this one, which is the part a shrink of the last control never buys.
 */
export function PanelTopBar() {
  const { t } = useLocale();
  const drawerOpen = usePanelUiStore((s) => s.drawerOpen);
  const setDrawerOpen = usePanelUiStore((s) => s.setDrawerOpen);

  return (
    <header className="sticky top-4 z-20 mx-4 mt-4 flex h-16 shrink-0 items-center justify-between gap-2 rounded-2xl border border-card-border bg-card-bg px-3 backdrop-blur-xl sm:px-6">
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          aria-label={t("common", S.openMenu)}
          aria-controls={PANEL_SIDEBAR_ID}
          aria-expanded={drawerOpen}
          className="rounded-lg bg-leaf-bg p-2 text-text-primary lg:hidden"
        >
          <Menu size={22} />
        </button>
      </div>
      <div className="flex min-w-0 items-center gap-1 sm:gap-3">
        <WalletButton />
        <NotificationsButton />
        <Divider className="hidden lg:block" />
        <AccountSwitcher />
        {/* Language and theme return at `lg`, not at `sm`. They belong to the
            drawer for exactly as long as the drawer exists, and the drawer
            exists below `lg`. Splitting the two breakpoints is what left the
            bar broken across the whole tablet band: at `sm` these two come
            back while the menu button is still there, so 640–1023px was the
            *widest* the row ever gets, not the narrowest. Measured at 700px:
            620px of content box against a row that wanted ~643px even after
            logout had moved out. Below `lg` it is now ~430px. */}
        <Divider className="hidden lg:block" />
        <div className="hidden lg:flex">
          <LangDropdown />
        </div>
        <Divider className="hidden lg:block" />
        <div className="hidden lg:flex">
          <ThemeDropdown />
        </div>
      </div>
    </header>
  );
}
