import { KeyRound, ShieldCheck, UserRound, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canProcessWithAccount, type AccountStatus } from "../../accountState";
import { formatDateTime, formatNumber } from "../../i18n/formatters";
import { useLocale } from "../../i18n/LocaleProvider";
import type { SupportedLocale } from "../../i18n/locale";
import { renderUiMessage } from "../../i18n/uiMessage";
import { useModalFocus } from "../modal/useModalFocus";
import type { AccountNotice } from "./useAccountController";

type AccountSheetProps = {
  open: boolean;
  account: AccountStatus;
  accountStatusText: string;
  accountNotice: AccountNotice;
  accountLoading: boolean;
  activationCodeDraft: string;
  activationRedeeming: boolean;
  onClose: () => void;
  onActivationCodeChange: (value: string) => void;
  onRedeemActivationCode: () => void;
  onSignOut: () => void;
  onStartLogin: () => void;
};

export function AccountSheet({
  open,
  account,
  accountStatusText,
  accountNotice,
  accountLoading,
  activationCodeDraft,
  activationRedeeming,
  onClose,
  onActivationCodeChange,
  onRedeemActivationCode,
  onSignOut,
  onStartLogin,
}: AccountSheetProps) {
  const { t } = useTranslation("account");
  const { resolvedLocale } = useLocale();
  const accountModalRef = useModalFocus<HTMLElement>(open);
  const renderedNotice = renderUiMessage(resolvedLocale, accountNotice);
  const quotaResetDate = formatAccountTimestamp(
    account.llmQuotaResetsAt,
    resolvedLocale,
  );

  if (!open) {
    return null;
  }

  return (
    <div className="modal-backdrop sheet-backdrop" role="presentation" onClick={onClose}>
      <section
        ref={accountModalRef}
        className="sheet-panel detail-modal account-modal account-sheet"
        aria-label={t("sheet.ariaLabel")}
        role="dialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-header sheet-header">
          <div>
            <p className="section-label">{t("sheet.eyebrow")}</p>
            <h2>{t("sheet.title")}</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            aria-label={t("sheet.closeAriaLabel")}
          >
            <X size={18} />
          </button>
        </header>
        <div className="account-content">
          <p className="settings-warning privacy-callout">
            <ShieldCheck size={16} />
            <span>{t("sheet.privacy")}</span>
          </p>
          <div className={`account-status-card ${canProcessWithAccount(account) ? "active" : "inactive"}`}>
            <div>
              <span className="account-status-label">{accountStatusText}</span>
              <strong>{account.email ?? t("status.accountFallback")}</strong>
              {account.serverError ? <small>{t("status.unavailable")}</small> : null}
            </div>
          </div>

          {account.authenticated ? (
            <div className="account-quota-grid">
              <div>
                <span className="account-status-label">
                  {t("quota.label", { defaultValue: "AI Credits" })}
                </span>
                <strong>
                  {t("quota.allocation", {
                    remaining: formatNumber(account.llmQuotaRemaining, resolvedLocale),
                    limit: formatNumber(account.llmQuotaLimit, resolvedLocale),
                  })}
                </strong>
                <small>
                  {quotaResetDate
                    ? t("quota.resetsAt", { date: quotaResetDate })
                    : t("quota.availableAfterActivation")}
                </small>
              </div>
              <div>
                <span className="account-status-label">{t("llm.label")}</span>
                <strong>{account.llmConfigured ? t("llm.ready") : t("llm.pending")}</strong>
                <small>{t("llm.description")}</small>
              </div>
            </div>
          ) : null}

          {account.authenticated && !canProcessWithAccount(account) ? (
            <div className="activation-panel">
              <div>
                <span className="account-status-label">{t("activation.label")}</span>
                <strong>{t("activation.title")}</strong>
                <small>{t("activation.description")}</small>
              </div>
              <input
                className="activation-code-input"
                value={activationCodeDraft}
                onChange={(event) => onActivationCodeChange(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    onRedeemActivationCode();
                  }
                }}
                aria-label={t("activation.label")}
                placeholder={t("activation.placeholder")}
                disabled={activationRedeeming}
              />
            </div>
          ) : null}

          {renderedNotice ? (
            <p
              className="action-notice inline-notice"
              role="status"
              aria-live="polite"
            >
              {renderedNotice}
            </p>
          ) : null}
        </div>
        <div className="settings-actions sheet-footer">
          {account.authenticated ? (
            <button type="button" className="secondary-button" onClick={onSignOut} disabled={accountLoading}>
              <span>{t("actions.signOut")}</span>
            </button>
          ) : (
            <button type="button" className="secondary-button" onClick={onClose}>
              <span>{t("actions.later")}</span>
            </button>
          )}
          {account.authenticated ? (
            <button
              type="button"
              className="primary-button"
              onClick={onRedeemActivationCode}
              disabled={activationRedeeming || canProcessWithAccount(account)}
            >
              <KeyRound size={16} />
              <span>
                {canProcessWithAccount(account)
                  ? t("actions.authorizationActive")
                  : activationRedeeming
                    ? t("actions.activationRedeeming")
                    : t("actions.redeemActivation")}
              </span>
            </button>
          ) : (
            <button type="button" className="primary-button" onClick={onStartLogin} disabled={accountLoading}>
              <UserRound size={16} />
              <span>{accountLoading ? t("actions.loginInProgress") : t("actions.emailSignIn")}</span>
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

function formatAccountTimestamp(
  value: string | null,
  locale: SupportedLocale,
): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : formatDateTime(date, locale);
}
