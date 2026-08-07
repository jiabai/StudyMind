import { beforeEach, describe, expect, test, vi } from "vitest";

type StateUpdater<T> = T | ((current: T) => T);

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

type HookHarness = {
  resetRender: () => void;
  useCallback: <T extends (...args: never[]) => unknown>(callback: T) => T;
  useEffect: () => void;
  useRef: <T>(initialValue: T) => { current: T };
  useState: <T>(initialValue: T | (() => T)) => [T, (next: StateUpdater<T>) => void];
};

const mocks = vi.hoisted(() => ({
  checkForAppUpdate: vi.fn(),
  getUpdateDelivery: vi.fn(),
  getUpdatePreferences: vi.fn(),
  installAppUpdate: vi.fn(),
  openReleasesPage: vi.fn(),
  relaunchApp: vi.fn(),
  saveUpdatePreferences: vi.fn(),
}));

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function update(version: string) {
  return {
    version,
    notes: `notes-${version}`,
    handle: {
      version,
      downloadAndInstall: vi.fn(),
    },
  };
}

function createHookHarness(): HookHarness {
  const states: unknown[] = [];
  const refs: Array<{ current: unknown }> = [];
  let stateCursor = 0;
  let refCursor = 0;

  return {
    resetRender: () => {
      stateCursor = 0;
      refCursor = 0;
    },
    useCallback: (callback) => callback,
    useEffect: () => undefined,
    useRef: <T,>(initialValue: T) => {
      const index = refCursor;
      refCursor += 1;
      if (!refs[index]) {
        refs[index] = { current: initialValue };
      }
      return refs[index] as { current: T };
    },
    useState: <T,>(initialValue: T | (() => T)) => {
      const index = stateCursor;
      stateCursor += 1;
      if (states.length <= index) {
        states[index] =
          typeof initialValue === "function"
            ? (initialValue as () => T)()
            : initialValue;
      }
      const setState = (next: StateUpdater<T>) => {
        states[index] =
          typeof next === "function"
            ? (next as (current: T) => T)(states[index] as T)
            : next;
      };
      return [states[index] as T, setState];
    },
  };
}

async function createController() {
  const harness = createHookHarness();
  vi.doMock("react", () => ({
    useCallback: harness.useCallback,
    useEffect: harness.useEffect,
    useRef: harness.useRef,
    useState: harness.useState,
  }));
  vi.doMock("../../updateClient", () => ({
    DEFAULT_RELEASES_URL: "https://example.test/releases",
    checkForAppUpdate: mocks.checkForAppUpdate,
    createDefaultUpdatePreferences: () => ({
      lastCheckedAt: null,
      postponedUntil: null,
      skippedVersion: null,
    }),
    getUpdateDelivery: mocks.getUpdateDelivery,
    getUpdatePreferences: mocks.getUpdatePreferences,
    installAppUpdate: mocks.installAppUpdate,
    openReleasesPage: mocks.openReleasesPage,
    relaunchApp: mocks.relaunchApp,
    saveUpdatePreferences: mocks.saveUpdatePreferences,
  }));
  const { useAppUpdateController } = await import("./useAppUpdateController");

  return {
    render: () => {
      harness.resetRender();
      return useAppUpdateController({
        processingActive: false,
        modelDownloadActive: false,
      });
    },
  };
}

describe("useAppUpdateController request ordering", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.saveUpdatePreferences.mockResolvedValue(undefined);
    mocks.installAppUpdate.mockResolvedValue(undefined);
  });

  test("only the latest concurrent check may commit when responses resolve out of order", async () => {
    const first = deferred<ReturnType<typeof update> | null>();
    const second = deferred<ReturnType<typeof update> | null>();
    mocks.checkForAppUpdate
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { render } = await createController();

    let controller = render();
    const firstCheck = controller.checkForUpdates({ silent: true });
    controller = render();
    const secondCheck = controller.checkForUpdates({ silent: false });

    second.resolve(update("2.0.0"));
    await secondCheck;
    controller = render();
    expect(controller.updateState.status).toBe("available");
    expect(controller.updateState.availableVersion).toBe("2.0.0");

    await controller.installUpdate();
    expect(mocks.installAppUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ version: "2.0.0" }),
      expect.any(Function),
    );

    first.resolve(update("1.0.0"));
    await firstCheck;
    controller = render();
    expect(controller.updateState.status).toBe("ready_to_restart");
    expect(controller.updateState.availableVersion).toBe("2.0.0");
  });

  test("an older rejection cannot overwrite a newer successful check", async () => {
    const first = deferred<ReturnType<typeof update> | null>();
    const second = deferred<ReturnType<typeof update> | null>();
    mocks.checkForAppUpdate
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { render } = await createController();

    let controller = render();
    const firstCheck = controller.checkForUpdates({ silent: false });
    controller = render();
    const secondCheck = controller.checkForUpdates({ silent: false });

    second.resolve(update("3.0.0"));
    await secondCheck;
    first.reject(new Error("HTTP status 503 token=do-not-store"));
    await firstCheck;

    controller = render();
    expect(controller.updateState.status).toBe("available");
    expect(controller.updateState.availableVersion).toBe("3.0.0");
    expect(controller.updateState.error).toBeNull();
  });

  test("starting installation invalidates an older pending check", async () => {
    const staleCheck = deferred<ReturnType<typeof update> | null>();
    const installCheck = deferred<ReturnType<typeof update> | null>();
    mocks.checkForAppUpdate
      .mockReturnValueOnce(staleCheck.promise)
      .mockReturnValueOnce(installCheck.promise);
    const { render } = await createController();

    let controller = render();
    const pendingCheck = controller.checkForUpdates({ silent: true });
    controller = render();
    const installation = controller.installUpdate();

    installCheck.resolve(update("4.0.0"));
    await installation;
    controller = render();
    expect(mocks.installAppUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ version: "4.0.0" }),
      expect.any(Function),
    );
    expect(controller.updateState.status).toBe("ready_to_restart");

    staleCheck.resolve(update("1.0.0"));
    await pendingCheck;
    controller = render();
    expect(controller.updateState.status).toBe("ready_to_restart");
    expect(controller.updateState.availableVersion).toBe("4.0.0");
  });

  test("does not start a new check while installation is active or awaiting restart", async () => {
    const installationDeferred = deferred<void>();
    mocks.checkForAppUpdate.mockResolvedValueOnce(update("5.0.0"));
    mocks.installAppUpdate.mockReturnValueOnce(installationDeferred.promise);
    const { render } = await createController();

    let controller = render();
    await controller.checkForUpdates({ silent: false });
    controller = render();
    const installation = controller.installUpdate();
    controller = render();
    expect(controller.updateState.status).toBe("downloading");

    await controller.checkForUpdates({ silent: true });
    controller = render();
    expect(mocks.checkForAppUpdate).toHaveBeenCalledTimes(1);
    expect(controller.updateState.status).toBe("downloading");

    installationDeferred.resolve(undefined);
    await installation;
    controller = render();
    expect(controller.updateState.status).toBe("ready_to_restart");

    await controller.checkForUpdates({ silent: false });
    controller = render();
    expect(mocks.checkForAppUpdate).toHaveBeenCalledTimes(1);
    expect(controller.updateState.status).toBe("ready_to_restart");
  });

  test("allows checks again after installation fails", async () => {
    mocks.checkForAppUpdate
      .mockResolvedValueOnce(update("6.0.0"))
      .mockResolvedValueOnce(update("6.1.0"));
    mocks.installAppUpdate.mockRejectedValueOnce(new Error("HTTP status 503"));
    const { render } = await createController();

    let controller = render();
    await controller.checkForUpdates({ silent: false });
    controller = render();
    await controller.installUpdate();
    controller = render();
    expect(controller.updateState.status).toBe("failed");

    await controller.checkForUpdates({ silent: false });
    controller = render();
    expect(mocks.checkForAppUpdate).toHaveBeenCalledTimes(2);
    expect(controller.updateState.status).toBe("available");
    expect(controller.updateState.availableVersion).toBe("6.1.0");
  });
});
