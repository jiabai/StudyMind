import { describe, expect, test, vi } from "vitest";
import {
  calculateDraggedWindowPosition,
  createWindowChromeActions,
  type WindowChromeCommandRunner,
} from "./windowChrome";

function createFakeRunner() {
  return vi.fn(async () => undefined) as WindowChromeCommandRunner;
}

describe("window chrome actions", () => {
  test("maps toolbar drag to the Rust window command", async () => {
    const runner = createFakeRunner();
    const chrome = createWindowChromeActions(runner);

    await chrome.startDrag();

    expect(runner).toHaveBeenCalledWith("start_window_drag");
  });

  test("maps traffic-light controls to Rust window commands", async () => {
    const runner = createFakeRunner();
    const chrome = createWindowChromeActions(runner);

    await chrome.close();
    await chrome.minimize();
    await chrome.toggleMaximize();

    expect(runner).toHaveBeenCalledWith("close_window");
    expect(runner).toHaveBeenCalledWith("minimize_window");
    expect(runner).toHaveBeenCalledWith("toggle_maximize_window");
  });

  test("maps manual drag position reads and writes to Rust window commands", async () => {
    const runner = createFakeRunner();
    const chrome = createWindowChromeActions(runner);

    await chrome.getPosition();
    await chrome.setPosition({ x: 320, y: 180 });

    expect(runner).toHaveBeenCalledWith("get_window_position");
    expect(runner).toHaveBeenCalledWith("set_window_position", { position: { x: 320, y: 180 } });
  });

  test("calculates the dragged window position from the pointer delta", () => {
    expect(
      calculateDraggedWindowPosition(
        { pointerX: 500, pointerY: 300, windowX: 240, windowY: 120 },
        { pointerX: 620, pointerY: 355 },
      ),
    ).toEqual({ x: 360, y: 175 });
  });
});
