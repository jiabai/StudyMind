import { type MouseEvent, useCallback, useEffect, useRef } from "react";

import {
  calculateDraggedWindowPosition,
  closeWindow as closeWindowCommand,
  getWindowPosition,
  minimizeWindow as minimizeWindowCommand,
  setWindowPosition,
  startWindowDrag,
  toggleMaximizeWindow as toggleMaximizeWindowCommand,
  type WindowDragSession,
  type WindowPosition,
} from "../../windowChrome";

type WindowChromeAction = () => Promise<void>;

export function useWindowChromeController() {
  const windowDragSessionRef = useRef<WindowDragSession | null>(null);
  const queuedWindowPositionRef = useRef<WindowPosition | null>(null);
  const windowMoveInFlightRef = useRef(false);

  const runWindowChromeAction = useCallback((action: WindowChromeAction) => {
    void action().catch((error) => {
      console.warn("Window chrome action failed", error);
    });
  }, []);

  const flushQueuedWindowPosition = useCallback(function flushQueuedWindowPosition() {
    if (windowMoveInFlightRef.current || !queuedWindowPositionRef.current) {
      return;
    }

    const position = queuedWindowPositionRef.current;
    queuedWindowPositionRef.current = null;
    windowMoveInFlightRef.current = true;
    void setWindowPosition(position)
      .catch((error) => {
        console.warn("Window drag move failed", error);
      })
      .finally(() => {
        windowMoveInFlightRef.current = false;
        flushQueuedWindowPosition();
      });
  }, []);

  const beginManualWindowDrag = useCallback(
    async (pointerX: number, pointerY: number) => {
      try {
        const position = await getWindowPosition();
        windowDragSessionRef.current = {
          pointerX,
          pointerY,
          windowX: position.x,
          windowY: position.y,
        };
      } catch (error) {
        console.warn("Manual window drag failed to start", error);
        runWindowChromeAction(startWindowDrag);
      }
    },
    [runWindowChromeAction],
  );

  const handleToolbarMouseDown = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      if (event.button !== 0) {
        return;
      }

      const target = event.target as HTMLElement;
      if (target.closest("button, input, select, textarea, a, [role='button']")) {
        return;
      }

      event.preventDefault();
      void beginManualWindowDrag(event.screenX, event.screenY);
    },
    [beginManualWindowDrag],
  );

  useEffect(() => {
    function moveManualWindowDrag(event: globalThis.MouseEvent) {
      const session = windowDragSessionRef.current;
      if (!session) {
        return;
      }

      queuedWindowPositionRef.current = calculateDraggedWindowPosition(session, {
        pointerX: event.screenX,
        pointerY: event.screenY,
      });
      flushQueuedWindowPosition();
    }

    function stopManualWindowDrag() {
      windowDragSessionRef.current = null;
      queuedWindowPositionRef.current = null;
    }

    window.addEventListener("mousemove", moveManualWindowDrag);
    window.addEventListener("mouseup", stopManualWindowDrag);
    window.addEventListener("blur", stopManualWindowDrag);
    return () => {
      window.removeEventListener("mousemove", moveManualWindowDrag);
      window.removeEventListener("mouseup", stopManualWindowDrag);
      window.removeEventListener("blur", stopManualWindowDrag);
    };
  }, [flushQueuedWindowPosition]);

  return {
    handleToolbarMouseDown,
    closeWindow: () => runWindowChromeAction(closeWindowCommand),
    minimizeWindow: () => runWindowChromeAction(minimizeWindowCommand),
    toggleMaximizeWindow: () => runWindowChromeAction(toggleMaximizeWindowCommand),
  };
}

export type WindowChromeController = ReturnType<typeof useWindowChromeController>;
