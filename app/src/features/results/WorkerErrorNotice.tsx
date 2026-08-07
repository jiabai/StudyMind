import type { SupportedLocale } from "../../i18n/locale";
import { formatNumber } from "../../i18n/formatters";
import { renderUiMessage, uiMessage } from "../../i18n/uiMessage";
import type { SafeTechnicalDetails } from "../../safeTechnicalDetails";
import { presentWorkerError } from "../../workerErrorCopy";
import type { WorkerErrorResult } from "../../workflow";

type WorkerErrorNoticeProps = {
  error: WorkerErrorResult;
  locale: SupportedLocale;
  className?: string;
};

const DETAIL_FIELDS = [
  "errorCode",
  "stageCode",
  "reasonCode",
  "httpStatus",
  "exitCode",
  "errno",
  "tools",
] as const satisfies ReadonlyArray<keyof SafeTechnicalDetails>;

export function WorkerErrorNotice({
  error,
  locale,
  className = "worker-error-notice",
}: WorkerErrorNoticeProps) {
  const presentation = presentWorkerError(error);
  const safeCode = presentation.technicalDetails.errorCode;
  const guidanceCode =
    presentation.messageCode === "errors.generic" && !safeCode
      ? "errors.genericNoCode"
      : presentation.messageCode;
  const guidance = renderUiMessage(
    locale,
    uiMessage(guidanceCode, safeCode ? { code: safeCode } : undefined),
  );
  const details = DETAIL_FIELDS.flatMap((field) => {
    const value = presentation.technicalDetails[field];
    return value === undefined
      ? []
      : [{ field, value: formatDetailValue(value, locale) }];
  });

  return (
    <div className={className} role="alert">
      <p>{guidance}</p>
      {details.length > 0 ? (
        <details>
          <summary>
            {renderUiMessage(locale, uiMessage("errors.technicalDetails"))}
          </summary>
          <dl>
            {details.map(({ field, value }) => (
              <div key={field}>
                <dt>
                  {renderUiMessage(
                    locale,
                    uiMessage(`errors.details.${field}`),
                  )}
                </dt>
                <dd>
                  <code>{value}</code>
                </dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
    </div>
  );
}

function formatDetailValue(
  value: NonNullable<SafeTechnicalDetails[keyof SafeTechnicalDetails]>,
  locale: SupportedLocale,
): string {
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  if (typeof value === "number") {
    return formatNumber(value, locale, { useGrouping: false });
  }
  return String(value);
}
