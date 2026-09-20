import { useCallback, useEffect, useRef, useState } from "react";

import {
  listLocalRecordings as defaultListRecordings,
  RecordingClientError,
  type RecordingClientErrorCode,
  type RecordingLibraryEntry,
  type RecordingLibraryView,
  type RecordingResult,
} from "../../recordingClient";

export type RecordingLibraryStatus = "loading" | "ready" | "error";

export type RecordingLibraryController = {
  status: RecordingLibraryStatus;
  entries: RecordingLibraryEntry[];
  totalBytes: number;
  errorCode?: RecordingClientErrorCode;
  highlightedId: string | null;
  savedNotice: boolean;
  refresh: () => Promise<void>;
  applySaved: (result: RecordingResult) => void;
};

export type UseRecordingLibraryOptions = {
  listRecordings?: () => Promise<RecordingLibraryView>;
  now?: () => number;
  scheduleTimeout?: (run: () => void, delayMs: number) => () => void;
};

const UNKNOWN_ERROR_CODE: RecordingClientErrorCode = "RECORDING_UNKNOWN_ERROR";

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

export function useRecordingLibrary(
  options: UseRecordingLibraryOptions = {},
): RecordingLibraryController {
  const listRecordings = options.listRecordings ?? defaultListRecordings;
  const now = options.now ?? Date.now;
  const scheduleTimeout = options.scheduleTimeout ?? defaultScheduleTimeout;
  const loaderRef = useRef(listRecordings);
  const nowRef = useRef(now);
  const scheduleTimeoutRef = useRef(scheduleTimeout);
  const mountedRef = useRef(true);
  const requestRef = useRef(0);
  const entriesRef = useRef<RecordingLibraryEntry[]>([]);
  const cancelHighlightRef = useRef<(() => void) | null>(null);
  const cancelSavedNoticeRef = useRef<(() => void) | null>(null);

  const [status, setStatus] = useState<RecordingLibraryStatus>("loading");
  const [entries, setEntries] = useState<RecordingLibraryEntry[]>([]);
  const [totalBytes, setTotalBytes] = useState(0);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);
  const [errorCode, setErrorCode] = useState<
    RecordingClientErrorCode | undefined
  >(undefined);

  useEffect(() => {
    loaderRef.current = listRecordings;
    nowRef.current = now;
    scheduleTimeoutRef.current = scheduleTimeout;
  }, [listRecordings, now, scheduleTimeout]);

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
    refresh,
    applySaved,
  };
}

function readErrorCode(error: unknown): RecordingClientErrorCode {
  return error instanceof RecordingClientError
    ? error.code
    : UNKNOWN_ERROR_CODE;
}
