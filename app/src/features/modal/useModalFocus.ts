import { useLayoutEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "object",
  "embed",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

type ModalEntry = {
  dialog: HTMLElement;
  parent: ModalEntry | null;
  restoreTarget: HTMLElement | null;
};

type InertRecord = {
  element: HTMLElement;
  wasInert: boolean;
};

const modalStack: ModalEntry[] = [];

function isFocusable(element: HTMLElement): boolean {
  return (
    element.getClientRects().length > 0 &&
    !element.hidden &&
    element.getAttribute("aria-hidden") !== "true" &&
    !element.closest("[inert]")
  );
}

function getFocusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    isFocusable,
  );
}

function setBackgroundInert(dialog: HTMLElement): InertRecord[] {
  const layer = dialog.parentElement;
  const parent = layer?.parentElement;
  if (!layer || !parent) {
    return [];
  }

  return Array.from(parent.children).flatMap((sibling) => {
    if (!(sibling instanceof HTMLElement) || sibling === layer) {
      return [];
    }
    const record = { element: sibling, wasInert: sibling.inert };
    sibling.inert = true;
    return [record];
  });
}

function restoreBackground(records: readonly InertRecord[]): void {
  for (const { element, wasInert } of records) {
    element.inert = wasInert;
  }
}

function firstInitialFocus(dialog: HTMLElement): HTMLElement | null {
  const preferred = dialog.querySelector<HTMLElement>(
    "[data-modal-initial-focus], [autofocus]",
  );
  if (preferred && isFocusable(preferred)) {
    return preferred;
  }
  return getFocusableElements(dialog)[0] ?? null;
}

function resolveRestoreTarget(entry: ModalEntry): HTMLElement | null {
  let current: ModalEntry | null = entry;
  while (current) {
    if (current.restoreTarget?.isConnected) {
      return current.restoreTarget;
    }
    current = current.parent;
  }
  return null;
}

function removeModalEntry(entry: ModalEntry): boolean {
  const index = modalStack.lastIndexOf(entry);
  if (index < 0) {
    return false;
  }
  const wasTop = index === modalStack.length - 1;
  modalStack.splice(index, 1);
  return wasTop;
}

export function useModalFocus<T extends HTMLElement>(open: boolean): RefObject<T | null> {
  const dialogRef = useRef<T>(null);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) {
      return;
    }

    const activeElement = document.activeElement;
    const entry: ModalEntry = {
      dialog,
      parent: modalStack[modalStack.length - 1] ?? null,
      restoreTarget: activeElement instanceof HTMLElement ? activeElement : null,
    };
    const background = setBackgroundInert(dialog);
    const hadTabIndex = dialog.hasAttribute("tabindex");
    const previousTabIndex = dialog.getAttribute("tabindex");
    if (!hadTabIndex) {
      dialog.tabIndex = -1;
    }
    modalStack.push(entry);

    (firstInitialFocus(dialog) ?? dialog).focus({ preventScroll: true });

    const trapFocus = (event: KeyboardEvent) => {
      if (
        event.key !== "Tab" ||
        modalStack[modalStack.length - 1] !== entry
      ) {
        return;
      }

      const focusable = getFocusableElements(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };

    document.addEventListener("keydown", trapFocus, true);
    return () => {
      document.removeEventListener("keydown", trapFocus, true);
      const wasTop = removeModalEntry(entry);
      restoreBackground(background);
      if (!hadTabIndex) {
        dialog.removeAttribute("tabindex");
      } else if (previousTabIndex !== null) {
        dialog.setAttribute("tabindex", previousTabIndex);
      }

      if (wasTop) {
        resolveRestoreTarget(entry)?.focus({ preventScroll: true });
      }
    };
  }, [open]);

  return dialogRef;
}
