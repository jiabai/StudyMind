import { useTranslation } from "react-i18next";

import type { SummaryAnnotation } from "../../annotationClient";

type AnnotationListPanelProps = {
  annotations: SummaryAnnotation[];
  colors: { key: string; label: string; className: string }[];
  onJumpTo: (annotation: SummaryAnnotation) => void;
  onEdit: (annotation: SummaryAnnotation) => void;
  onDelete: (id: string) => void;
  visible: boolean;
  onToggleVisible: () => void;
};

export function AnnotationListPanel({
  annotations,
  colors,
  onJumpTo,
  onEdit,
  onDelete,
  visible,
  onToggleVisible,
}: AnnotationListPanelProps) {
  const { t } = useTranslation("synthesis");

  const groupedByTab = annotations.reduce<Record<string, SummaryAnnotation[]>>(
    (acc, ann) => {
      if (!acc[ann.target_tab]) {
        acc[ann.target_tab] = [];
      }
      acc[ann.target_tab].push(ann);
      return acc;
    },
    {},
  );

  const tabLabels: Record<string, string> = {
    summary: t("annotation.tabSummary"),
    insights: t("annotation.tabInsights"),
    dissection: t("annotation.tabDissection"),
  };

  const getColorClass = (key: string | null) =>
    colors.find((c) => c.key === key)?.className ?? "";

  return (
    <div
      className={`task-domain-workspace annotation-panel ${visible ? "visible" : "collapsed"}`}
    >
      <button
        className="annotation-panel-toggle"
        onClick={onToggleVisible}
        title={visible ? t("annotation.panelToggleExpanded") : t("annotation.panelToggleCollapsed")}
      >
        <span className="annotation-panel-icon">📝</span>
        <span className="annotation-panel-count">{annotations.length}</span>
      </button>

      {visible && (
        <div className="annotation-panel-content">
          <h3 className="annotation-panel-title">{t("annotation.panelTitle")}</h3>
          {annotations.length === 0 ? (
            <p className="annotation-panel-empty">
              {t("annotation.panelEmpty")}
            </p>
          ) : (
            Object.entries(groupedByTab).map(([tab, anns]) => (
              <div key={tab} className="annotation-panel-group">
                <h4 className="annotation-panel-group-title">
                  {tabLabels[tab] ?? tab}
                  <span className="annotation-panel-group-count">
                    {anns.length}
                  </span>
                </h4>
                <ul className="annotation-panel-list">
                  {anns
                    .sort((a, b) => a.char_index - b.char_index)
                    .map((ann) => (
                      <li
                        key={ann.id}
                        className={`annotation-item ${getColorClass(ann.color)}`}
                      >
                        <button
                          className="annotation-item-anchor"
                          onClick={() => onJumpTo(ann)}
                          title={ann.text_anchor}
                        >
                          <span className="annotation-item-quote">
                            "{ann.text_anchor.length > 30
                              ? ann.text_anchor.slice(0, 30) + "…"
                              : ann.text_anchor}
                            "
                          </span>
                          <span className="annotation-item-content">
                            {ann.content}
                          </span>
                        </button>
                        <div className="annotation-item-actions">
                          <button
                            className="annotation-item-edit"
                            onClick={() => onEdit(ann)}
                            title={t("annotation.editAria")}
                          >
                            ✎
                          </button>
                          <button
                            className="annotation-item-delete"
                            onClick={() => onDelete(ann.id)}
                            title={t("annotation.deleteAria")}
                          >
                            ✕
                          </button>
                        </div>
                      </li>
                    ))}
                </ul>
              </div>
            ))
          )}
          {annotations.length > 0 && (
            <div className="annotation-panel-footer">
              <span className="annotation-panel-hint">
                {t("annotation.totalAnnotations", { count: annotations.length })}
              </span>
              <div className="annotation-panel-legend">
                {colors.map((c) => (
                  <span key={c.key} className="annotation-legend-item">
                    <span
                      className={`annotation-color-dot ${c.className}`}
                      style={{ display: "inline-block" }}
                    />
                    {c.label}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
