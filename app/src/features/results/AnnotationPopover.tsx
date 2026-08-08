import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { SummaryAnnotation } from "../../annotationClient";

type AnnotationPopoverProps = {
  isOpen: boolean;
  position: { x: number; y: number };
  textAnchor: string;
  existingAnnotation: SummaryAnnotation | null;
  colors: { key: string; label: string; className: string }[];
  onSave: (content: string, color: string | null) => void;
  onDelete: () => void;
  onClose: () => void;
};

export function AnnotationPopover({
  isOpen,
  position,
  textAnchor,
  existingAnnotation,
  colors,
  onSave,
  onDelete,
  onClose,
}: AnnotationPopoverProps) {
  const { t } = useTranslation("synthesis");
  const [content, setContent] = useState(existingAnnotation?.content ?? "");
  const [selectedColor, setSelectedColor] = useState<string | null>(
    existingAnnotation?.color ?? null,
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      setContent(existingAnnotation?.content ?? "");
      setSelectedColor(existingAnnotation?.color ?? null);
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }, [isOpen, existingAnnotation]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const handleClickOutside = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen) {
    return null;
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = content.trim();
    if (!trimmed) {
      return;
    }
    onSave(trimmed, selectedColor);
    onClose();
  };

  return (
    <div
      ref={popoverRef}
      className="annotation-popover"
      style={{
        position: "fixed",
        left: position.x,
        top: position.y,
        zIndex: 1000,
      }}
    >
      <div className="annotation-popover-header">
        <span className="annotation-popover-anchor">
          {textAnchor.length > 40 ? textAnchor.slice(0, 40) + "…" : textAnchor}
        </span>
        <button
          className="annotation-popover-close"
          onClick={onClose}
          aria-label={t("annotation.closeAria")}
        >
          ✕
        </button>
      </div>
      <form onSubmit={handleSubmit}>
        <textarea
          ref={textareaRef}
          className="annotation-popover-textarea"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={t("annotation.placeholder")}
          rows={3}
        />
        <div className="annotation-popover-colors">
          {colors.map((c) => (
            <button
              key={c.key}
              type="button"
              className={`annotation-color-dot ${c.className} ${
                selectedColor === c.key ? "selected" : ""
              }`}
              onClick={() =>
                setSelectedColor(selectedColor === c.key ? null : c.key)
              }
              title={c.label}
              aria-label={c.label}
            />
          ))}
        </div>
        <div className="annotation-popover-actions">
          {existingAnnotation && (
            <button
              type="button"
              className="annotation-popover-delete"
              onClick={() => {
                onDelete();
                onClose();
              }}
            >
              {t("annotation.delete")}
            </button>
          )}
          <div className="annotation-popover-spacer" />
          <button
            type="submit"
            className="annotation-popover-save"
            disabled={!content.trim()}
          >
            {existingAnnotation ? t("annotation.updateTitle") : t("annotation.addTitle")}
          </button>
        </div>
      </form>
    </div>
  );
}
