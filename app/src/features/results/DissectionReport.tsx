import { LocateFixed } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { TranscriptDissection } from "../../workflow";

type Props = {
  report: TranscriptDissection;
  stale: boolean;
  sourceLocationDisabled?: boolean;
  onLocateChunks: (chunkIds: number[]) => void;
};

export function DissectionReport({ report, stale, sourceLocationDisabled = false, onLocateChunks }: Props) {
  const { t } = useTranslation("synthesis");
  const narrative = report.overallNarrative;
  return (
    <div className="dissection-report">
      {stale ? <p className="dissection-stale-banner" role="status">{t("dissection.report.stale")}</p> : null}
      <section className="dissection-overview">
        <h3>{t("dissection.report.narrative")}</h3>
        <dl>
          <ReportField label={t("dissection.report.structureType")} value={narrative.structureType} />
          <ReportField label={t("dissection.report.openingHook")} value={narrative.openingHook} />
          <ReportField label={t("dissection.report.turningPoint")} value={narrative.turningPoint} />
          <ReportField label={t("dissection.report.closingType")} value={narrative.closingType} />
        </dl>
      </section>
      <section>
        <h3>{t("dissection.report.segments")}</h3>
        <div className="dissection-segment-list">
          {report.segments.map((segment) => (
            <article className="dissection-segment-card" key={segment.id}>
              <header><span>{segment.id}</span><h4>{segment.title}</h4></header>
              <p className="dissection-core-claim">{segment.coreClaim}</p>
              <StringList title={t("dissection.report.supportingPoints")} values={segment.supportingPoints} />
              <StringList title={t("dissection.report.rhetoricalDevices")} values={segment.rhetoricalDevices} />
              <dl>
                <ReportField label={t("dissection.report.rhythm")} value={segment.rhythmNote} />
                <ReportField label={t("dissection.report.reusablePattern")} value={segment.reusablePattern} />
              </dl>
              <StringList title={t("dissection.report.riskFlags")} values={segment.riskFlags} />
              <div className="dissection-source-chunks" aria-label={t("dissection.report.sourceChunks")}>
                {segment.sourceChunkIds.map((chunkId) => <span key={chunkId}>{chunkId}</span>)}
              </div>
              <button
                type="button"
                className="secondary-button compact-button"
                data-source-chunks={segment.sourceChunkIds.join(",")}
                disabled={stale || sourceLocationDisabled}
                title={stale || sourceLocationDisabled ? t("dissection.report.locateDisabled") : undefined}
                onClick={() => onLocateChunks(segment.sourceChunkIds)}
              >
                <LocateFixed size={15} />
                <span>{t("dissection.report.locateSource")}</span>
              </button>
            </article>
          ))}
        </div>
      </section>
      <section className="dissection-global-grid">
        <StringList title={t("dissection.report.highlights")} values={report.highlights.slice(0, 8)} />
        <StringList title={t("dissection.report.strengths")} values={report.strengths.slice(0, 6)} />
        <StringList title={t("dissection.report.weaknesses")} values={report.weaknesses.slice(0, 6)} />
        <div><h3>{t("dissection.report.template")}</h3><strong>{report.reusableTemplate.name}</strong><ol>{report.reusableTemplate.skeleton.map((step) => <li key={step}>{step}</li>)}</ol></div>
        <div><h3>{t("dissection.report.audienceFit")}</h3><ul>{report.audienceFit.map((item) => <li className="dissection-audience-item" key={`${item.audience}-${item.fit}`}><strong>{item.audience}</strong><span>{t(`dissection.report.fit.${item.fit}`)}</span><span>{item.note}</span></li>)}</ul></div>
      </section>
    </div>
  );
}

function ReportField({ label, value }: { label: string; value: string | null }) {
  return value ? <div><dt>{label}</dt><dd>{value}</dd></div> : null;
}

function StringList({ title, values }: { title: string; values: string[] }) {
  return values.length > 0 ? <div><h3>{title}</h3><ul>{values.map((value, index) => <li key={`${index}-${value}`}>{value}</li>)}</ul></div> : null;
}
