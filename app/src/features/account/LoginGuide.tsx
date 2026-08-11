import { LoaderCircle, UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";

export type LoginGuideFooterLinks = {
  privacyUrl?: string;
  termsUrl?: string;
};

type LoginGuideProps = {
  loginInProgress: boolean;
  onLogin: () => void;
  footerLinks?: LoginGuideFooterLinks;
  onOpenLink?: (url: string) => void;
};

export function LoginGuide({
  loginInProgress,
  onLogin,
  footerLinks = {},
  onOpenLink,
}: LoginGuideProps) {
  const { t } = useTranslation("account");
  const privacyUrl = footerLinks.privacyUrl;
  const termsUrl = footerLinks.termsUrl;

  return (
    <div className="login-guide" role="region" aria-label={t("guide.ariaLabel")}>
      <div className="login-guide-mascot" aria-hidden="true">
        <MascotMark />
      </div>
      <h1 className="login-guide-tagline">{t("guide.tagline")}</h1>
      <p className="login-guide-subtitle">{t("guide.subtitle")}</p>
      <button
        type="button"
        className="primary-button login-guide-login"
        onClick={onLogin}
        disabled={loginInProgress}
      >
        {loginInProgress ? (
          <LoaderCircle className="spin" size={16} />
        ) : (
          <UserRound size={16} />
        )}
        <span>{loginInProgress ? t("actions.loginInProgress") : t("guide.login")}</span>
      </button>
      {privacyUrl || termsUrl ? (
        <nav className="login-guide-links" aria-label={t("guide.footerLinksAria")}>
          {privacyUrl ? (
            <a
              className="login-guide-link"
              href={privacyUrl}
              onClick={(event) => {
                event.preventDefault();
                onOpenLink?.(privacyUrl);
              }}
            >
              {t("guide.privacyPolicy")}
            </a>
          ) : null}
          {termsUrl ? (
            <a
              className="login-guide-link"
              href={termsUrl}
              onClick={(event) => {
                event.preventDefault();
                onOpenLink?.(termsUrl);
              }}
            >
              {t("guide.termsOfService")}
            </a>
          ) : null}
        </nav>
      ) : null}
      <p className="login-guide-privacy">{t("guide.privacyNote")}</p>
    </div>
  );
}

function MascotMark() {
  return (
    <svg
      className="login-guide-mascot-svg"
      viewBox="0 0 240 232"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <ellipse cx="120" cy="222" rx="54" ry="6" fill="rgba(126, 155, 138, 0.12)" />
      <path
        d="M92 79 L72 34 L112 71"
        stroke="#7e9b8a"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M148 79 L168 34 L128 71"
        stroke="#7e9b8a"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M86 176 q0 40 34 40 q34 0 34 -40 Z"
        fill="rgba(252, 250, 244, 0.72)"
        stroke="#7e9b8a"
        strokeWidth="4"
        strokeLinejoin="round"
      />
      <path
        d="M84 178 q-16 10 -8 28"
        stroke="#7e9b8a"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <path
        d="M156 178 q16 10 8 28"
        stroke="#7e9b8a"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <circle
        cx="120"
        cy="118"
        r="48"
        fill="rgba(252, 250, 244, 0.72)"
        stroke="#7e9b8a"
        strokeWidth="4"
      />
      <rect
        x="66"
        y="114"
        width="20"
        height="44"
        rx="10"
        fill="rgba(126, 155, 138, 0.1)"
        stroke="#7e9b8a"
        strokeWidth="4"
      />
      <rect
        x="154"
        y="114"
        width="20"
        height="44"
        rx="10"
        fill="rgba(126, 155, 138, 0.1)"
        stroke="#7e9b8a"
        strokeWidth="4"
      />
      <path
        d="M96 100 q24 -10 48 0"
        stroke="rgba(126, 155, 138, 0.35)"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <circle cx="104" cy="118" r="5.5" fill="#7e9b8a" />
      <circle cx="136" cy="118" r="5.5" fill="#7e9b8a" />
      <path
        d="M86 126 q8 6 16 2"
        stroke="rgba(126, 155, 138, 0.4)"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <path
        d="M138 126 q8 6 16 2"
        stroke="rgba(126, 155, 138, 0.4)"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <path
        d="M110 134 Q120 143 130 134"
        stroke="#7e9b8a"
        strokeWidth="3.5"
        strokeLinecap="round"
      />
      <path
        d="M106 186 h28 M106 198 h28"
        stroke="rgba(126, 155, 138, 0.5)"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
