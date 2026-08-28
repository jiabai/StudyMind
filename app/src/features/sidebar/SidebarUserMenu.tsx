import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronUp, LogOut, Settings, Sparkles, UserRound } from "lucide-react";

import type { AccountStatus } from "../../accountState";

type SidebarUserMenuProps = {
  account: AccountStatus;
  onOpenAccount: () => void;
  onOpenSettings: () => void;
  onSignOut: () => void;
  signOutDisabled: boolean;
};

export function deriveUserName(account: AccountStatus, guestLabel: string): string {
  if (!account.authenticated || !account.email) {
    return guestLabel;
  }
  return account.email.split("@")[0] || guestLabel;
}

function avatarInitial(userName: string, signedIn: boolean): string | null {
  if (!signedIn) {
    return null;
  }
  const initial = userName.trim().charAt(0).toUpperCase();
  return initial || null;
}

export function SidebarUserMenuItems({
  signedIn,
  userName,
  quotaRemaining,
  onOpenAccount,
  onOpenSettings,
  onSignOut,
  signOutDisabled,
}: {
  signedIn: boolean;
  userName: string;
  quotaRemaining: number;
  onOpenAccount: () => void;
  onOpenSettings: () => void;
  onSignOut: () => void;
  signOutDisabled: boolean;
}) {
  const { t } = useTranslation("sidebar");

  return (
    <>
      <div className="sidebar-user-menu-header">
        <span className="sidebar-user-avatar large" aria-hidden="true">
          {avatarInitial(userName, signedIn) ?? <UserRound size={16} />}
        </span>
        <div>
          <strong>{userName}</strong>
          <small>{signedIn ? t("userMenu.signedIn") : t("userMenu.guest")}</small>
        </div>
      </div>
      <div className="sidebar-user-menu-status" role="status">
        <Sparkles size={15} />
        <span>{t("userMenu.credits")}</span>
        <span className="sidebar-user-menu-value">{quotaRemaining}</span>
      </div>
      <button
        role="menuitem"
        type="button"
        className="sidebar-user-menu-item"
        onClick={onOpenAccount}
      >
        <UserRound size={15} />
        <span>{t("userMenu.account")}</span>
      </button>
      <button
        role="menuitem"
        type="button"
        className="sidebar-user-menu-item"
        onClick={onOpenSettings}
      >
        <Settings size={15} />
        <span>{t("userMenu.settings")}</span>
      </button>
      <button
        role="menuitem"
        type="button"
        className="sidebar-user-menu-item danger"
        onClick={onSignOut}
        disabled={!signedIn || signOutDisabled}
      >
        <LogOut size={15} />
        <span>{t("userMenu.signOut")}</span>
      </button>
    </>
  );
}

export function SidebarUserMenu({
  account,
  onOpenAccount,
  onOpenSettings,
  onSignOut,
  signOutDisabled,
}: SidebarUserMenuProps) {
  const { t } = useTranslation("sidebar");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      if (
        rootRef.current &&
        !rootRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const signedIn = account.authenticated;
  const userName = deriveUserName(account, t("userMenu.guest"));
  const initial = avatarInitial(userName, signedIn);

  return (
    <div className="sidebar-user" ref={rootRef}>
      <button
        type="button"
        className="sidebar-user-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("userMenu.aria")}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="sidebar-user-avatar" aria-hidden="true">
          {initial ?? <UserRound size={15} />}
        </span>
        <span className="sidebar-user-name">{userName}</span>
        <ChevronUp size={14} className={`sidebar-user-caret${open ? " open" : ""}`} />
      </button>
      {open ? (
        <div className="sidebar-user-menu" role="menu" aria-label={t("userMenu.aria")}>
          <SidebarUserMenuItems
            signedIn={signedIn}
            userName={userName}
            quotaRemaining={account.llmQuotaRemaining}
            onOpenAccount={() => {
              setOpen(false);
              onOpenAccount();
            }}
            onOpenSettings={() => {
              setOpen(false);
              onOpenSettings();
            }}
            onSignOut={() => {
              setOpen(false);
              onSignOut();
            }}
            signOutDisabled={signOutDisabled}
          />
        </div>
      ) : null}
    </div>
  );
}
