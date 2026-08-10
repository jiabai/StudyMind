import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const COLLAPSED_KEY = "studymind.sidebar.collapsed";
const storage = new Map<string, string>();

function installStorageMock(): void {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
  });
}

afterEach(() => {
  storage.clear();
  vi.unstubAllGlobals();
});

type StateUpdater<T> = T | ((current: T) => T);

type HookHarness = {
  resetRender: () => void;
  useCallback: <T extends (...args: never[]) => unknown>(callback: T) => T;
  useEffect: (effect: () => void) => void;
  useState: <T>(initialValue: T | (() => T)) => [T, (next: StateUpdater<T>) => void];
  runEffects: () => void;
};

function createHookHarness(): HookHarness {
  const states: unknown[] = [];
  const effects: (() => void)[] = [];
  let cursor = 0;

  return {
    resetRender: () => {
      cursor = 0;
    },
    useCallback: (callback) => callback,
    useEffect: (effect) => {
      effects.push(effect);
    },
    useState: <T,>(initialValue: T | (() => T)) => {
      const stateIndex = cursor;
      cursor += 1;
      if (states.length <= stateIndex) {
        states[stateIndex] =
          typeof initialValue === "function"
            ? (initialValue as () => T)()
            : initialValue;
      }
      return [
        states[stateIndex] as T,
        (next: StateUpdater<T>) => {
          states[stateIndex] =
            typeof next === "function"
              ? (next as (current: T) => T)(states[stateIndex] as T)
              : next;
        },
      ];
    },
    runEffects: () => {
      for (const effect of effects) {
        effect();
      }
    },
  };
}

async function createSidebarState() {
  const harness = createHookHarness();
  vi.doMock("react", () => ({
    useCallback: harness.useCallback,
    useEffect: harness.useEffect,
    useState: harness.useState,
  }));
  const { useSidebarState: loadUseSidebarState } = await import("./useSidebarState");
  return {
    render: () => {
      harness.resetRender();
      return loadUseSidebarState();
    },
    runEffects: harness.runEffects,
  };
}

describe("useSidebarState", () => {
  beforeEach(() => {
    vi.resetModules();
    installStorageMock();
  });

  test("starts expanded when storage has no collapsed marker", async () => {
    const { render } = await createSidebarState();

    expect(render().collapsed).toBe(false);
  });

  test("starts collapsed when the storage marker is set", async () => {
    storage.set(COLLAPSED_KEY, "1");
    const { render } = await createSidebarState();

    expect(render().collapsed).toBe(true);
  });

  test("toggles between collapsed and expanded", async () => {
    const { render } = await createSidebarState();

    const first = render();
    first.toggleCollapsed();
    expect(render().collapsed).toBe(true);

    render().toggleCollapsed();
    expect(render().collapsed).toBe(false);
  });

  test("persists the collapsed marker through its effect", async () => {
    const { render, runEffects } = await createSidebarState();

    render().toggleCollapsed();
    render();
    runEffects();
    expect(storage.get(COLLAPSED_KEY)).toBe("1");
  });
});
