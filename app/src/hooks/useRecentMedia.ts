import { useCallback, useState } from "react";

import type { LocalMediaKind, LocalMediaSelectionView } from "../localMediaContract";

export type RecentMediaEntry = {
  name: string;
  path: string;
  kind: LocalMediaKind;
  sizeBytes: number;
  lastUsedAt: number;
};

const STORAGE_KEY = "studymind.recentMedia.v1";
const MAX_ENTRIES = 5;

function isEntry(value: unknown): value is RecentMediaEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.name === "string" &&
    typeof entry.path === "string" &&
    (entry.kind === "audio" || entry.kind === "video") &&
    typeof entry.sizeBytes === "number" &&
    typeof entry.lastUsedAt === "number"
  );
}

function loadEntries(): RecentMediaEntry[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isEntry)
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      .slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

function persistEntries(entries: RecentMediaEntry[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // 存储不可用（隐私模式/配额）时静默降级为内存态
  }
}

/**
 * 最近使用的本地媒体文件（路径级去重，最多 MAX_ENTRIES 条）。
 * 纯前端持久化，用于空态快速复用文件，不依赖 worker 历史。
 */
export function useRecentMedia() {
  const [entries, setEntries] = useState<RecentMediaEntry[]>(loadEntries);

  const recordRecent = useCallback(
    (path: string, selection: LocalMediaSelectionView) => {
      setEntries((prev) => {
        const next: RecentMediaEntry[] = [
          {
            name: selection.displayName,
            path,
            kind: selection.mediaKind,
            sizeBytes: selection.sizeBytes,
            lastUsedAt: Date.now(),
          },
          ...prev.filter((entry) => entry.path !== path),
        ].slice(0, MAX_ENTRIES);
        persistEntries(next);
        return next;
      });
    },
    [],
  );

  const removeRecent = useCallback((path: string) => {
    setEntries((prev) => {
      const next = prev.filter((entry) => entry.path !== path);
      persistEntries(next);
      return next;
    });
  }, []);

  const clearRecent = useCallback(() => {
    setEntries([]);
    persistEntries([]);
  }, []);

  return { recentMedia: entries, recordRecent, removeRecent, clearRecent };
}
