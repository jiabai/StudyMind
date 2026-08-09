import { useCallback, useEffect, useState } from "react";

const SIDEBAR_COLLAPSED_KEY = "studymind.sidebar.collapsed";

function readCollapsedFromStorage(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function persistCollapsed(value: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, value ? "1" : "0");
  } catch {
    // Storage may be unavailable (private mode, quota); state still works in-memory.
  }
}

export function useSidebarState() {
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsedFromStorage);

  useEffect(() => {
    persistCollapsed(collapsed);
  }, [collapsed]);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => !prev);
  }, []);

  return {
    collapsed,
    toggleCollapsed,
  };
}

export type SidebarState = ReturnType<typeof useSidebarState>;
