import { invoke, type InvokeArgs } from "@tauri-apps/api/core";

export type WindowChromeCommand =
  | "start_window_drag"
  | "close_window"
  | "minimize_window"
  | "toggle_maximize_window"
  | "get_window_position"
  | "set_window_position";

export type WindowPosition = {
  x: number;
  y: number;
};

export type WindowDragSession = {
  pointerX: number;
  pointerY: number;
  windowX: number;
  windowY: number;
};

export type WindowChromeCommandRunner = <T = void>(
  command: WindowChromeCommand,
  args?: InvokeArgs,
) => Promise<T>;

const defaultWindowChromeRunner: WindowChromeCommandRunner = (command, args) => invoke(command, args);

export function createWindowChromeActions(runner: WindowChromeCommandRunner = defaultWindowChromeRunner) {
  return {
    startDrag: () => runner("start_window_drag"),
    minimize: () => runner("minimize_window"),
    toggleMaximize: () => runner("toggle_maximize_window"),
    close: () => runner("close_window"),
    getPosition: () => runner<WindowPosition>("get_window_position"),
    setPosition: (position: WindowPosition) => runner("set_window_position", { position }),
  };
}

export function startWindowDrag(runner?: WindowChromeCommandRunner) {
  return createWindowChromeActions(runner).startDrag();
}

export function minimizeWindow(runner?: WindowChromeCommandRunner) {
  return createWindowChromeActions(runner).minimize();
}

export function toggleMaximizeWindow(runner?: WindowChromeCommandRunner) {
  return createWindowChromeActions(runner).toggleMaximize();
}

export function closeWindow(runner?: WindowChromeCommandRunner) {
  return createWindowChromeActions(runner).close();
}

export function getWindowPosition(runner?: WindowChromeCommandRunner) {
  return createWindowChromeActions(runner).getPosition();
}

export function setWindowPosition(position: WindowPosition, runner?: WindowChromeCommandRunner) {
  return createWindowChromeActions(runner).setPosition(position);
}

export function calculateDraggedWindowPosition(
  session: WindowDragSession,
  currentPointer: Pick<WindowDragSession, "pointerX" | "pointerY">,
): WindowPosition {
  return {
    x: Math.round(session.windowX + currentPointer.pointerX - session.pointerX),
    y: Math.round(session.windowY + currentPointer.pointerY - session.pointerY),
  };
}
