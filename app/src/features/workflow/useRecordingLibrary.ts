import { useCallback, useEffect, useRef, useState } from "react";

import { selectLocalMediaByPath as defaultSelectLocalMediaByPath } from "../../localMediaClient";
import type { LocalMediaSelectionView } from "../../localMediaContract";
import {
  listLocalRecordings as defaultListRecordings,
  RecordingClientError,
  type RecordingClientErrorCode,
  type RecordingLibraryEntry,
  type RecordingLibraryView,
  type RecordingResult,
} from "../../recordingClient";

export type RecordingLibraryStatus = "loading" | "ready" | "error";

/**
 * 单条录音的导入状态。
 * saved 是默认态；已导入只放内存，重启应用后回到 saved。
 */
export type RecordingEntryStatus =
  | "saved"
  | "importing"
  | "imported"
  | "importFailed";

export type RecordingEntryState = {
  status: RecordingEntryStatus;
  /** 导入失败时保留底层错误码，用于直接定位是路径不可读还是格式不支持。 */
  errorCode?: string;
};

export type RecordingLibraryController = {
  status: RecordingLibraryStatus;
  entries: RecordingLibraryEntry[];
  totalBytes: number;
  errorCode?: RecordingClientErrorCode;
  highlightedId: string | null;
  savedNotice: boolean;
  entryStates: Record<string, RecordingEntryState>;
  refresh: () => Promise<void>;
  applySaved: (result: RecordingResult) => void;
  importEntry: (entry: RecordingLibraryEntry) => Promise<boolean>;
};

export type UseRecordingLibraryOptions = {
  listRecordings?: () => Promise<RecordingLibraryView>;
  selectLocalMediaByPath?: (path: string) => Promise<LocalMediaSelectionView>;
  onLocalMediaSelected?: (selection: LocalMediaSelectionView) => void;
  recordRecent?: (path: string, selection: LocalMediaSelectionView) => void;
  now?: () => number;
  scheduleTimeout?: (run: () => void, delayMs: number) => () => void;
};

const UNKNOWN_ERROR_CODE: RecordingClientErrorCode = "RECORDING_UNKNOWN_ERROR";

// 导入失败时宁可只显示一个笼统的错误码，也不把任意异常文本带进界面。
const IMPORT_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;

// 2 秒保持 + 0.3 秒淡出。这个总时长必须与 App.css 里 recording-library-highlight
// 动画的「延迟 + 时长」一致：到点后透明度已经是 0，此时移除类不会造成视觉跳变。
const HIGHLIGHT_DURATION_MS = 2_300;

// 卡片轻提示比列表高亮略长，够看清又不长期占位。
const SAVED_NOTICE_DURATION_MS = 4_000;

// 录音文件名就是录音条目的稳定标识，Rust 侧列举命令同样以文件名作为 recordingId。
function recordingIdFromPath(path: string): string {
  const segments = path.split(/[\\/]/);
  return segments[segments.length - 1] ?? path;
}

function defaultScheduleTimeout(run: () => void, delayMs: number): () => void {
  const handle = globalThis.setTimeout(run, delayMs);
  return () => globalThis.clearTimeout(handle);
}

function readImportErrorCode(error: unknown): string {
  if (typeof error === "string" && IMPORT_ERROR_CODE_PATTERN.test(error)) {
    return error;
  }
  if (error instanceof Error && IMPORT_ERROR_CODE_PATTERN.test(error.message)) {
    return error.message;
  }
  return UNKNOWN_ERROR_CODE;
}

// 文件被移出录音目录后，它残留的导入状态没有意义，跟着列表一起丢掉。
function pruneEntryStates(
  states: Record<string, RecordingEntryState>,
  entries: readonly RecordingLibraryEntry[],
): Record<string, RecordingEntryState> {
  const live = new Set(entries.map((item) => item.recordingId));
  const next: Record<string, RecordingEntryState> = {};
  for (const [recordingId, state] of Object.entries(states)) {
    if (live.has(recordingId)) {
      next[recordingId] = state;
    }
  }
  return next;
}

export function useRecordingLibrary(
  options: UseRecordingLibraryOptions = {},
): RecordingLibraryController {
  const listRecordings = options.listRecordings ?? defaultListRecordings;
  const selectLocalMediaByPath =
    options.selectLocalMediaByPath ?? defaultSelectLocalMediaByPath;
  const onLocalMediaSelected = options.onLocalMediaSelected ?? (() => undefined);
  const recordRecent = options.recordRecent ?? (() => undefined);
  const now = options.now ?? Date.now;
  const scheduleTimeout = options.scheduleTimeout ?? defaultScheduleTimeout;
  const loaderRef = useRef(listRecordings);
  const nowRef = useRef(now);
  const scheduleTimeoutRef = useRef(scheduleTimeout);
  const selectLocalMediaByPathRef = useRef(selectLocalMediaByPath);
  const onLocalMediaSelectedRef = useRef(onLocalMediaSelected);
  const recordRecentRef = useRef(recordRecent);
  const mountedRef = useRef(true);
  const requestRef = useRef(0);
  const entriesRef = useRef<RecordingLibraryEntry[]>([]);
  const importingRef = useRef<Set<string>>(new Set());
  const cancelHighlightRef = useRef<(() => void) | null>(null);
  const cancelSavedNoticeRef = useRef<(() => void) | null>(null);

  const [status, setStatus] = useState<RecordingLibraryStatus>("loading");
  const [entries, setEntries] = useState<RecordingLibraryEntry[]>([]);
  const [totalBytes, setTotalBytes] = useState(0);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);
  const [entryStates, setEntryStates] = useState<
    Record<string, RecordingEntryState>
  >({});
  const [errorCode, setErrorCode] = useState<
    RecordingClientErrorCode | undefined
  >(undefined);

  useEffect(() => {
    loaderRef.current = listRecordings;
    nowRef.current = now;
    scheduleTimeoutRef.current = scheduleTimeout;
    selectLocalMediaByPathRef.current = selectLocalMediaByPath;
    onLocalMediaSelectedRef.current = onLocalMediaSelected;
    recordRecentRef.current = recordRecent;
  }, [
    listRecordings,
    now,
    scheduleTimeout,
    selectLocalMediaByPath,
    onLocalMediaSelected,
    recordRecent,
  ]);

  const refresh = useCallback(async () => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    try {
      const next = await loaderRef.current();
      if (!mountedRef.current || requestRef.current !== requestId) {
        return;
      }
      entriesRef.current = next.entries;
      setEntries(next.entries);
      setTotalBytes(next.totalBytes);
      setEntryStates((current) => pruneEntryStates(current, next.entries));
      setErrorCode(undefined);
      setStatus("ready");
    } catch (error) {
      if (!mountedRef.current || requestRef.current !== requestId) {
        return;
      }
      setErrorCode(readErrorCode(error));
      setStatus("error");
    }
  }, []);

  const applySaved = useCallback(
    (result: RecordingResult) => {
      const saved: RecordingLibraryEntry = {
        recordingId: recordingIdFromPath(result.path),
        path: result.path,
        displayName: result.displayName,
        sizeBytes: result.sizeBytes,
        durationMs: result.durationMs,
        createdAtMs: nowRef.current(),
      };
      const next = [
        saved,
        ...entriesRef.current.filter(
          (item) => item.recordingId !== saved.recordingId,
        ),
      ];
      entriesRef.current = next;
      setEntries(next);
      setTotalBytes(next.reduce((sum, item) => sum + item.sizeBytes, 0));
      setStatus("ready");
      cancelHighlightRef.current?.();
      setHighlightedId(saved.recordingId);
      cancelHighlightRef.current = scheduleTimeoutRef.current(() => {
        cancelHighlightRef.current = null;
        if (mountedRef.current) {
          setHighlightedId(null);
        }
      }, HIGHLIGHT_DURATION_MS);
      cancelSavedNoticeRef.current?.();
      setSavedNotice(true);
      cancelSavedNoticeRef.current = scheduleTimeoutRef.current(() => {
        cancelSavedNoticeRef.current = null;
        if (mountedRef.current) {
          setSavedNotice(false);
        }
      }, SAVED_NOTICE_DURATION_MS);
      void refresh();
    },
    [refresh],
  );

  // 导入复用既有的按路径选择本地媒体链路：选中后录音才成为当前任务的 LocalMediaSource。
  // 失败只标记这一条，用户可以在同一条上重试，不必重录。
  const importEntry = useCallback(
    async (entry: RecordingLibraryEntry): Promise<boolean> => {
      const { recordingId, path } = entry;
      if (importingRef.current.has(recordingId)) {
        return false;
      }
      importingRef.current.add(recordingId);
      setEntryStates((current) => ({
        ...current,
        [recordingId]: { status: "importing" },
      }));
      try {
        const selection = await selectLocalMediaByPathRef.current(path);
        if (!mountedRef.current) {
          return false;
        }
        recordRecentRef.current(path, selection);
        onLocalMediaSelectedRef.current(selection);
        setEntryStates((current) => ({
          ...current,
          [recordingId]: { status: "imported" },
        }));
        return true;
      } catch (error) {
        if (!mountedRef.current) {
          return false;
        }
        setEntryStates((current) => ({
          ...current,
          [recordingId]: {
            status: "importFailed",
            errorCode: readImportErrorCode(error),
          },
        }));
        return false;
      } finally {
        importingRef.current.delete(recordingId);
      }
    },
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
      cancelHighlightRef.current?.();
      cancelHighlightRef.current = null;
      cancelSavedNoticeRef.current?.();
      cancelSavedNoticeRef.current = null;
    };
  }, [refresh]);

  return {
    status,
    entries,
    totalBytes,
    errorCode,
    highlightedId,
    savedNotice,
    entryStates,
    refresh,
    applySaved,
    importEntry,
  };
}

function readErrorCode(error: unknown): RecordingClientErrorCode {
  return error instanceof RecordingClientError
    ? error.code
    : UNKNOWN_ERROR_CODE;
}
