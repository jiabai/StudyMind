import { useCallback, useEffect, useRef, useState } from "react";

import {
  listLocalRecordings as defaultListRecordings,
  RecordingClientError,
  type RecordingClientErrorCode,
  type RecordingLibraryEntry,
  type RecordingLibraryView,
} from "../../recordingClient";

export type RecordingLibraryStatus = "loading" | "ready" | "error";

export type RecordingLibraryController = {
  status: RecordingLibraryStatus;
  entries: RecordingLibraryEntry[];
  totalBytes: number;
  errorCode?: RecordingClientErrorCode;
  refresh: () => Promise<void>;
};

export type UseRecordingLibraryOptions = {
  listRecordings?: () => Promise<RecordingLibraryView>;
};

const UNKNOWN_ERROR_CODE: RecordingClientErrorCode = "RECORDING_UNKNOWN_ERROR";

export function useRecordingLibrary(
  options: UseRecordingLibraryOptions = {},
): RecordingLibraryController {
  const listRecordings = options.listRecordings ?? defaultListRecordings;
  const loaderRef = useRef(listRecordings);
  const mountedRef = useRef(true);
  const requestRef = useRef(0);

  const [status, setStatus] = useState<RecordingLibraryStatus>("loading");
  const [entries, setEntries] = useState<RecordingLibraryEntry[]>([]);
  const [totalBytes, setTotalBytes] = useState(0);
  const [errorCode, setErrorCode] = useState<
    RecordingClientErrorCode | undefined
  >(undefined);

  useEffect(() => {
    loaderRef.current = listRecordings;
  }, [listRecordings]);

  const refresh = useCallback(async () => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    try {
      const next = await loaderRef.current();
      if (!mountedRef.current || requestRef.current !== requestId) {
        return;
      }
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

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  return { status, entries, totalBytes, errorCode, refresh };
}

function readErrorCode(error: unknown): RecordingClientErrorCode {
  return error instanceof RecordingClientError
    ? error.code
    : UNKNOWN_ERROR_CODE;
}
