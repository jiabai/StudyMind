import { StudyMindI18n } from "./i18n";
import type { SupportedLocale } from "./locale";

export type UiMessageArgs = Readonly<Record<string, string | number>>;

export type UiMessage = Readonly<{
  messageCode: string;
  args?: UiMessageArgs;
}>;

const INTERNAL_MESSAGE_CODE_PATTERN =
  /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9][A-Za-z0-9_-]*)+$/;

type DynamicI18n = {
  exists(key: string, options: { lng: string; ns: string }): boolean;
  getFixedT(
    locale: string,
    namespace: string,
  ): (key: string, args?: UiMessageArgs) => unknown;
};

export function uiMessage(
  messageCode: string,
  args?: UiMessageArgs,
): UiMessage {
  return args === undefined ? { messageCode } : { messageCode, args };
}

export function renderUiMessage(
  locale: SupportedLocale,
  message: UiMessage | null,
): string {
  if (
    !message ||
    !INTERNAL_MESSAGE_CODE_PATTERN.test(message.messageCode)
  ) {
    return "";
  }

  const separator = message.messageCode.indexOf(".");
  const namespace = message.messageCode.slice(0, separator);
  const key = message.messageCode.slice(separator + 1);
  const dynamicI18n = StudyMindI18n as unknown as DynamicI18n;
  if (!dynamicI18n.exists(key, { lng: locale, ns: namespace })) {
    return "";
  }

  return String(
    dynamicI18n.getFixedT(locale, namespace)(key, message.args ?? {}),
  );
}
