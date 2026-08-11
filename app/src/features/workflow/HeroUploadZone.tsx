import { useState, useCallback, useEffect, useRef, type DragEvent, type MouseEvent } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
  FileAudio,
  FileVideo,
  LoaderCircle,
  RefreshCw,
  Upload,
  X,
  Sparkles,
  Shield,
  Zap,
} from "lucide-react";

import { formatBytes } from "../../i18n/formatters";
import { useLocale } from "../../i18n/LocaleProvider";
import { useRecentMedia, type RecentMediaEntry } from "../../hooks/useRecentMedia";
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

type TranslateFn = TFunction<"workflow", undefined>;

function relativeTimeLabel(timestamp: number, t: TranslateFn): string {
  const diffMinutes = Math.floor((Date.now() - timestamp) / 60_000);
  if (diffMinutes < 1) return t("input.hero.recentJustNow");
  if (diffMinutes < 60) return t("input.hero.recentMinutes", { count: diffMinutes });
  const hours = Math.floor(diffMinutes / 60);
  if (hours < 24) return t("input.hero.recentHours", { count: hours });
  return t("input.hero.recentDays", { count: Math.floor(hours / 24) });
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
  const titleInputRef = useRef<HTMLInputElement>(null);
  const { recentMedia, recordRecent, removeRecent, clearRecent } = useRecentMedia();

  const selection = source.kind === "local_media" ? source.selection : null;

  useEffect(() => {
    if (selection) {
      setState("has-selection");
    } else {
      setState((prev) => (prev === "has-selection" || prev === "loading" ? "idle" : prev));
      setTopicTitle("");
    }
  }, [selection]);

  // 选中就绪后自动聚焦课题标题，减少一步操作
  useEffect(() => {
    if (state === "has-selection" && selection) {
      titleInputRef.current?.focus();
    }
  }, [state, selection]);

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    // has-selection 也允许拖入：松开即可替换当前文件
    if (state === "idle" || state === "error" || state === "has-selection") {
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
      recordRecent(filePath, result);
      setState("has-selection");
    } catch {
      setErrorMessage(t("input.hero.errorValidationFailed"));
      setState("error");
    }
  }, [t, onLocalMediaSelected, recordRecent]);

  const handleClick = useCallback(async (replace = false) => {
    if (picking) return;
    if (selection && !replace) return;
    setPicking(true);
    setErrorMessage("");
    setState("loading");
    try {
      const result = await selectLocalMedia();
      if (result) {
        onLocalMediaSelected(result);
        setState("has-selection");
      } else {
        // 替换模式下取消选择器：保留原有文件
        setState(replace && selection ? "has-selection" : "idle");
      }
    } catch {
      setErrorMessage(t("input.hero.errorPickerFailed"));
      setState("error");
    } finally {
      setPicking(false);
    }
  }, [t, selection, picking, onLocalMediaSelected]);

  const handleRecentClick = useCallback(
    async (entry: RecentMediaEntry) => {
      if (picking) return;
      setPicking(true);
      setErrorMessage("");
      setState("loading");
      try {
        const result = await selectLocalMediaByPath(entry.path);
        onLocalMediaSelected(result);
        recordRecent(entry.path, result);
        setState("has-selection");
      } catch {
        // 文件已不存在/不可读：自动从最近使用中剔除死条目
        removeRecent(entry.path);
        setErrorMessage(t("input.hero.recentErrorGone"));
        setState("error");
      } finally {
        setPicking(false);
      }
    },
    [t, picking, onLocalMediaSelected, recordRecent, removeRecent],
  );

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
        onClick={!selection && !picking ? () => void handleClick() : undefined}
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
            <p className="hero-upload-drop-hint">
              {selection ? t("input.hero.dragReplaceHint") : t("input.hero.dragOverHint")}
            </p>
          </div>
        )}

        {state === "loading" && !selection && (
          <div className="hero-upload-content loading">
            <div className="hero-upload-icon loading">
              <LoaderCircle className="spin" size={40} strokeWidth={1.5} />
            </div>
            <p className="hero-upload-drop-hint">{t("input.hero.openingPicker")}</p>
          </div>
        )}

        {showSelection && selection && (
          <div className="hero-upload-selected">
            <div className="hero-upload-file-row">
              <div className={`hero-upload-file-icon ${selection.mediaKind}`}>
                {selection.mediaKind === "audio" ? (
                  <FileAudio size={22} strokeWidth={1.8} />
                ) : (
                  <FileVideo size={22} strokeWidth={1.8} />
                )}
              </div>
              <div className="hero-upload-file-info">
                <strong title={selection.displayName}>{selection.displayName}</strong>
                <span>
                  {selection.mediaKind === "audio" ? t("input.attachment.kind.audio") : t("input.attachment.kind.video")} · {formatBytes(selection.sizeBytes, resolvedLocale)}
                </span>
              </div>
              <button
                className="hero-upload-remove"
                type="button"
                onClick={handleRemove}
                aria-label={t("input.attachment.removeAria", { name: selection.displayName })}
                title={t("input.attachment.removeAria", { name: selection.displayName })}
                disabled={removing}
              >
                {removing ? <LoaderCircle className="spin" size={15} /> : <X size={16} />}
              </button>
            </div>

            <label className="hero-upload-title-field">
              <span className="hero-upload-title-label">{t("input.hero.titleLabel")}</span>
              <input
                ref={titleInputRef}
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
                className="hero-upload-replace"
                type="button"
                onClick={() => void handleClick(true)}
                disabled={picking}
              >
                <RefreshCw size={14} />
                {t("input.hero.replace")}
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

      {state === "idle" && recentMedia.length > 0 && (
        <div className="hero-recent">
          <div className="hero-recent-header">
            <span className="hero-recent-label">{t("input.hero.recentLabel")}</span>
            <button
              className="hero-recent-clear"
              type="button"
              onClick={clearRecent}
              aria-label={t("input.hero.recentClearAria")}
            >
              {t("input.hero.recentClear")}
            </button>
          </div>
          <ul className="hero-recent-list">
            {recentMedia.map((entry) => (
              <li key={entry.path} className="hero-recent-item">
                <button
                  className="hero-recent-open"
                  type="button"
                  onClick={() => void handleRecentClick(entry)}
                  aria-label={t("input.hero.recentOpenAria", { name: entry.name })}
                >
                  <span className={`hero-recent-icon ${entry.kind}`}>
                    {entry.kind === "audio" ? (
                      <FileAudio size={14} strokeWidth={1.8} />
                    ) : (
                      <FileVideo size={14} strokeWidth={1.8} />
                    )}
                  </span>
                  <span className="hero-recent-text">
                    <span className="hero-recent-name" title={entry.name}>
                      {entry.name}
                    </span>
                    <span className="hero-recent-meta">
                      {entry.kind === "audio"
                        ? t("input.attachment.kind.audio")
                        : t("input.attachment.kind.video")}
                      {" · "}
                      {formatBytes(entry.sizeBytes, resolvedLocale)}
                      {" · "}
                      {relativeTimeLabel(entry.lastUsedAt, t)}
                    </span>
                  </span>
                </button>
                <button
                  className="hero-recent-remove"
                  type="button"
                  onClick={() => removeRecent(entry.path)}
                  aria-label={t("input.hero.recentRemoveAria", { name: entry.name })}
                  title={t("input.hero.recentRemoveAria", { name: entry.name })}
                >
                  <X size={13} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

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