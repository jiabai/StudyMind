import { useState, useCallback, useEffect, type DragEvent, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  FileAudio,
  FileVideo,
  LoaderCircle,
  Upload,
  X,
  Sparkles,
  Shield,
  Zap,
} from "lucide-react";

import { formatBytes } from "../../i18n/formatters";
import { useLocale } from "../../i18n/LocaleProvider";
import { selectLocalMedia, selectLocalMediaByPath } from "../../localMediaClient";
import type { LocalMediaSelectionView } from "../../localMediaContract";
import type { TaskComposerSource, TaskSubmission } from "../../workflowState";

type HeroState = "idle" | "drag-over" | "has-selection" | "error" | "loading";

type HeroUploadZoneProps = {
  source: TaskComposerSource;
  canSubmit: boolean;
  statusBody: string;
  onLocalMediaSelected: (selection: LocalMediaSelectionView) => void;
  onRemoveLocalMedia: () => Promise<boolean>;
  onSubmit: (submission: TaskSubmission) => void;
};

const AUDIO_EXTS = new Set(["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "wma"]);
const VIDEO_EXTS = new Set(["mp4", "m4v", "mov", "mkv", "avi", "wmv", "webm"]);

function getExt(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function classifyExt(ext: string): "audio" | "video" | null {
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (VIDEO_EXTS.has(ext)) return "video";
  return null;
}

export function HeroUploadZone({
  source,
  canSubmit,
  onLocalMediaSelected,
  onRemoveLocalMedia,
  onSubmit,
}: HeroUploadZoneProps) {
  const { t } = useTranslation("workflow");
  const { resolvedLocale } = useLocale();
  const [state, setState] = useState<HeroState>("idle");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [picking, setPicking] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [topicTitle, setTopicTitle] = useState<string>("");

  const selection = source.kind === "local_media" ? source.selection : null;

  useEffect(() => {
    if (selection) {
      setState("has-selection");
    } else {
      setState((prev) => (prev === "has-selection" || prev === "loading" ? "idle" : prev));
      setTopicTitle("");
    }
  }, [selection]);

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (state === "idle" || state === "error") {
      setState("drag-over");
    }
  }, [state]);

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (state === "drag-over") {
      setState(selection ? "has-selection" : "idle");
    }
  }, [state, selection]);

  const handleDrop = useCallback(async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();

    const files = e.dataTransfer.files;
    if (files.length === 0) return;

    const file = files[0];
    const ext = getExt(file.name);
    const kind = classifyExt(ext);

    if (!kind) {
      setErrorMessage(t("input.hero.errorUnsupported", { ext: ext || "未知格式" }));
      setState("error");
      return;
    }

    const filePath = (file as File & { path?: string }).path;
    if (!filePath) {
      setErrorMessage(t("input.hero.errorNoPath"));
      setState("error");
      return;
    }

    setState("loading");
    try {
      const result = await selectLocalMediaByPath(filePath);
      onLocalMediaSelected(result);
      setState("has-selection");
    } catch {
      setErrorMessage(t("input.hero.errorValidationFailed"));
      setState("error");
    }
  }, [t, onLocalMediaSelected]);

  const handleClick = useCallback(async () => {
    if (selection || picking) return;
    setPicking(true);
    setErrorMessage("");
    setState("loading");
    try {
      const result = await selectLocalMedia();
      if (result) {
        onLocalMediaSelected(result);
        setState("has-selection");
      } else {
        setState("idle");
      }
    } catch {
      setErrorMessage(t("input.hero.errorPickerFailed"));
      setState("error");
    } finally {
      setPicking(false);
    }
  }, [t, selection, picking, onLocalMediaSelected]);

  const handleRemove = useCallback(async (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    setRemoving(true);
    const removed = await onRemoveLocalMedia();
    setRemoving(false);
    if (!removed) {
      setErrorMessage(t("input.hero.errorRemoveFailed"));
      return;
    }
    setErrorMessage("");
    setState("idle");
  }, [t, onRemoveLocalMedia]);

  const handleSubmit = useCallback((e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (!selection) return;
    const trimmedTitle = topicTitle.trim();
    onSubmit({
      kind: "local_media",
      selectionToken: selection.selectionToken,
      ...(trimmedTitle ? { title: trimmedTitle } : {}),
    });
  }, [selection, onSubmit, topicTitle]);

  const zoneClasses = [
    "hero-upload-zone",
    state === "drag-over" ? "drag-over" : "",
    state === "has-selection" ? "has-selection" : "",
    state === "error" ? "error" : "",
    state === "loading" ? "loading" : "",
  ].filter(Boolean).join(" ");

  const showSelection = selection && (state === "has-selection" || state === "loading");

  return (
    <div className="hero-upload-zone-wrapper">
      <div className="hero-upload-header">
        <h1>{t("input.hero.title")}</h1>
        <p>{t("input.hero.subtitle")}</p>
      </div>

      <div
        className={zoneClasses}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={!selection && !picking ? handleClick : undefined}
        role="button"
        tabIndex={0}
        aria-label={selection ? t("input.hero.ariaSelected") : t("input.hero.ariaIdle")}
        aria-busy={state === "loading"}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && !selection && !picking) {
            e.preventDefault();
            void handleClick();
          }
        }}
      >
        {state === "idle" && (
          <div className="hero-upload-content">
            <div className="hero-upload-icon">
              <Upload size={48} strokeWidth={1.5} />
            </div>
            <p className="hero-upload-drop-hint">{t("input.hero.dropHint")}</p>
            <p className="hero-upload-sub-hint">{t("input.hero.subHint")}</p>
          </div>
        )}

        {state === "drag-over" && (
          <div className="hero-upload-content drag-over">
            <div className="hero-upload-icon drag-over">
              <Upload size={56} strokeWidth={1.5} />
            </div>
            <p className="hero-upload-drop-hint">{t("input.hero.dragOverHint")}</p>
          </div>
        )}

        {state === "loading" && (
          <div className="hero-upload-content loading">
            <div className="hero-upload-icon loading">
              <LoaderCircle className="spin" size={40} strokeWidth={1.5} />
            </div>
            <p className="hero-upload-drop-hint">{selection ? t("input.hero.preparing") : t("input.hero.openingPicker")}</p>
          </div>
        )}

        {showSelection && selection && (
          <div className="hero-upload-content has-selection">
            <div className={`hero-upload-file-icon ${selection.mediaKind}`}>
              {selection.mediaKind === "audio" ? (
                <FileAudio size={40} strokeWidth={1.5} />
              ) : (
                <FileVideo size={40} strokeWidth={1.5} />
              )}
            </div>
            <div className="hero-upload-file-info">
              <strong title={selection.displayName}>{selection.displayName}</strong>
              <span>
                {selection.mediaKind === "audio" ? t("input.attachment.kind.audio") : t("input.attachment.kind.video")} · {formatBytes(selection.sizeBytes, resolvedLocale)}
              </span>
            </div>
            <label className="hero-upload-title-field">
              <span className="hero-upload-title-label">{t("input.hero.titleLabel")}</span>
              <input
                className="hero-upload-title-input"
                type="text"
                value={topicTitle}
                maxLength={80}
                placeholder={t("input.hero.titlePlaceholder")}
                aria-label={t("input.hero.titleAriaLabel")}
                onChange={(e) => setTopicTitle(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
              />
            </label>
            <div className="hero-upload-actions">
              <button
                className="hero-upload-remove"
                type="button"
                onClick={handleRemove}
                aria-label={t("input.attachment.removeAria", { name: selection.displayName })}
                disabled={removing}
              >
                {removing ? <LoaderCircle className="spin" size={16} /> : <X size={18} />}
              </button>
              <button
                className="primary-button hero-upload-submit"
                type="button"
                onClick={handleSubmit}
                disabled={!canSubmit || removing}
              >
                {t("input.hero.submit")}
              </button>
            </div>
          </div>
        )}

        {state === "error" && (
          <div className="hero-upload-content error">
            <div className="hero-upload-icon error">
              <X size={48} strokeWidth={1.5} />
            </div>
            <p className="hero-upload-error-text">{errorMessage}</p>
            <button
              className="hero-upload-retry"
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setErrorMessage("");
                setState("idle");
              }}
            >
              {t("input.hero.retry")}
            </button>
          </div>
        )}
      </div>

      <div className="hero-upload-features">
        <div className="hero-feature-item">
          <Zap size={16} />
          <span>{t("input.hero.featureTranscription")}</span>
        </div>
        <div className="hero-feature-item">
          <Shield size={16} />
          <span>{t("input.hero.featurePrivacy")}</span>
        </div>
        <div className="hero-feature-item">
          <Sparkles size={16} />
          <span>{t("input.hero.featureSummary")}</span>
        </div>
      </div>
    </div>
  );
}