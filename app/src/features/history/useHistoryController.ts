import { useCallback, useRef, useState } from "react";

import {
  deleteHistoryTask,
  getHistory,
  getHistoryDetail,
  type HistoryItem,
  type HistoryListItem,
} from "../../historyClient";
import { uiMessage, type UiMessage } from "../../i18n/uiMessage";

type UseHistoryControllerOptions = {
  onHistoryItemSelected: (item: HistoryItem) => void;
  onHistoryItemDeleted: (taskId: string) => void;
  onPrepareHistoryItemDeletion: (taskId: string) => void;
};

export function useHistoryController({
  onHistoryItemSelected,
  onHistoryItemDeleted,
  onPrepareHistoryItemDeletion,
}: UseHistoryControllerOptions) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyItems, setHistoryItems] = useState<HistoryListItem[]>([]);
  const [historyNotice, setHistoryNotice] = useState<UiMessage | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyDeleteCandidate, setHistoryDeleteCandidate] = useState<HistoryListItem | null>(null);
  const [historyDeleting, setHistoryDeleting] = useState(false);
  const listRequestIdRef = useRef(0);
  const detailRequestIdRef = useRef(0);
  const deleteRequestPendingRef = useRef(false);

  const closeHistory = useCallback(() => {
    listRequestIdRef.current += 1;
    detailRequestIdRef.current += 1;
    setHistoryOpen(false);
    if (!deleteRequestPendingRef.current) {
      setHistoryDeleteCandidate(null);
    }
  }, []);

  const openHistory = useCallback(async () => {
    const requestId = listRequestIdRef.current + 1;
    listRequestIdRef.current = requestId;
    detailRequestIdRef.current += 1;
    setHistoryDeleteCandidate(null);
    setHistoryOpen(true);
    setHistoryLoading(true);
    setHistoryItems([]);
    setHistoryNotice(uiMessage("history.notice.loading"));
    try {
      const items = await getHistory();
      if (listRequestIdRef.current !== requestId) {
        return;
      }
      setHistoryItems(items);
      setHistoryNotice(items.length > 0 ? null : uiMessage("history.notice.empty"));
    } catch {
      if (listRequestIdRef.current === requestId) {
        setHistoryNotice(uiMessage("history.notice.loadFailed"));
      }
    } finally {
      if (listRequestIdRef.current === requestId) {
        setHistoryLoading(false);
      }
    }
  }, []);

  const openHistoryItem = useCallback(
    async (item: HistoryListItem) => {
      listRequestIdRef.current += 1;
      const requestId = detailRequestIdRef.current + 1;
      detailRequestIdRef.current = requestId;
      setHistoryLoading(true);
      setHistoryNotice(uiMessage("history.notice.detailLoading"));
      try {
        const detail = await getHistoryDetail(item.taskId);
        if (detailRequestIdRef.current !== requestId) {
          return;
        }
        onHistoryItemSelected(detail);
        setHistoryOpen(false);
        setHistoryNotice(null);
      } catch {
        if (detailRequestIdRef.current === requestId) {
          setHistoryNotice(uiMessage("history.notice.detailFailed"));
        }
      } finally {
        if (detailRequestIdRef.current === requestId) {
          setHistoryLoading(false);
        }
      }
    },
    [onHistoryItemSelected],
  );

  const requestHistoryItemDeletion = useCallback((item: HistoryListItem) => {
    listRequestIdRef.current += 1;
    detailRequestIdRef.current += 1;
    setHistoryDeleteCandidate(item);
    setHistoryNotice(null);
  }, []);

  const cancelHistoryItemDeletion = useCallback(() => {
    if (!deleteRequestPendingRef.current) {
      setHistoryDeleteCandidate(null);
    }
  }, []);

  const confirmHistoryItemDeletion = useCallback(async () => {
    if (!historyDeleteCandidate || deleteRequestPendingRef.current) {
      return;
    }
    const taskId = historyDeleteCandidate.taskId;
    deleteRequestPendingRef.current = true;
    const listRequestId = listRequestIdRef.current + 1;
    listRequestIdRef.current = listRequestId;
    detailRequestIdRef.current += 1;
    setHistoryDeleting(true);
    setHistoryNotice(uiMessage("history.notice.deleting"));
    onPrepareHistoryItemDeletion(taskId);
    try {
      await deleteHistoryTask(taskId);
      listRequestIdRef.current += 1;
      setHistoryItems((current) => current.filter((item) => item.taskId !== taskId));
      setHistoryDeleteCandidate(null);
      setHistoryNotice(uiMessage("history.notice.deleted"));
      onHistoryItemDeleted(taskId);
    } catch {
      if (listRequestIdRef.current !== listRequestId) {
        return;
      }
      const recoveryRequestId = listRequestIdRef.current + 1;
      listRequestIdRef.current = recoveryRequestId;
      try {
        const items = await getHistory();
        if (listRequestIdRef.current === recoveryRequestId) {
          setHistoryItems(items);
        }
      } catch {
        // Keep the last safe list when the follow-up manifest projection is unavailable.
      }
      if (listRequestIdRef.current === recoveryRequestId) {
        setHistoryNotice(uiMessage("history.notice.deleteFailed"));
      }
    } finally {
      deleteRequestPendingRef.current = false;
      setHistoryDeleting(false);
    }
  }, [
    historyDeleteCandidate,
    onHistoryItemDeleted,
    onPrepareHistoryItemDeletion,
  ]);

  return {
    historyOpen,
    historyItems,
    historyNotice,
    historyLoading,
    historyDeleteCandidate,
    historyDeleting,
    closeHistory,
    openHistory,
    openHistoryItem,
    requestHistoryItemDeletion,
    cancelHistoryItemDeletion,
    confirmHistoryItemDeletion,
  };
}

export type HistoryController = ReturnType<typeof useHistoryController>;
