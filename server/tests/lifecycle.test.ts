import { describe, expect, test, vi } from "vitest";
import { runServerLifecycle, shutdownRuntime } from "../src/bootstrap.js";
import { createRuntimeLogger, STUDYMIND_CODES, STUDYMIND_EVENTS } from "../src/observability.js";

describe("server lifecycle", () => {
  test("starts config, database, readiness, and listener in order", async () => {
    const calls: string[] = [];
    const runtime = await runServerLifecycle({
      loadConfig: () => { calls.push("config"); return { host: "127.0.0.1", port: 8787 } as never; },
      connectDatabase: async () => { calls.push("database"); return { $disconnect: async () => { calls.push("disconnect"); } } as never; },
      buildRuntime: async () => { calls.push("readiness"); return { app: { listen: async () => { calls.push("listen"); }, close: async () => { calls.push("close"); } }, readiness: { beginDraining: () => calls.push("draining") } } as never; },
      installSignalHandlers: false,
    });
    expect(calls).toEqual(["config", "database", "readiness", "listen"]);
    await runtime.shutdown("test");
    expect(calls.slice(-3)).toEqual(["draining", "close", "disconnect"]);
  });

  test("cleans connected resources after startup failure without listening", async () => {
    const disconnect = vi.fn(async () => undefined);
    await expect(runServerLifecycle({ loadConfig: () => ({ host: "127.0.0.1", port: 1 }) as never, connectDatabase: async () => ({ $disconnect: disconnect }) as never, buildRuntime: async () => { throw new Error("schema invalid"); }, installSignalHandlers: false })).rejects.toThrow("schema invalid");
    expect(disconnect).toHaveBeenCalledOnce();
  });

  test("a hanging close consumes the shared deadline and forces a nonzero exit", async () => {
    const draining = vi.fn(); const disconnect = vi.fn(async () => undefined);
    const never = new Promise<void>(() => undefined);
    const forceExit = vi.fn();
    const shutdown = shutdownRuntime({ app: { close: () => never }, prisma: { $disconnect: disconnect }, readiness: { beginDraining: draining }, timeoutMs: 5, forceExit });
    const [first, second] = await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT")]);
    expect(first.exitCode).toBe(1); expect(second).toBe(first); expect(draining).toHaveBeenCalledOnce(); expect(disconnect).not.toHaveBeenCalled(); expect(forceExit).toHaveBeenCalledOnce(); expect(forceExit).toHaveBeenCalledWith(1);
  });

  test("a hanging disconnect uses only the remainder of the shared deadline", async () => {
    const calls: string[] = []; const forceExit = vi.fn(); const started = Date.now();
    const shutdown = shutdownRuntime({ app: { close: async () => { calls.push("close"); } }, prisma: { $disconnect: () => { calls.push("disconnect"); return new Promise<void>(() => undefined); } }, readiness: { beginDraining: () => calls.push("draining") }, timeoutMs: 10, forceExit });
    expect(await shutdown("SIGTERM")).toEqual({ exitCode: 1, signal: "SIGTERM" });
    expect(Date.now() - started).toBeLessThan(200);
    expect(calls).toEqual(["draining", "close", "disconnect"]);
    expect(forceExit).toHaveBeenCalledOnce(); expect(forceExit).toHaveBeenCalledWith(1);
  });

  test("emits fixed lifecycle events without leaking startup failures", async () => {
    const records: unknown[] = []; const secret = "PRISMA_URL_SECRET_DETAIL";
    const logger = createRuntimeLogger({ info: (record) => records.push(record), error: (record) => records.push(record) });
    await expect(runServerLifecycle({ loadConfig: () => ({ host: "127.0.0.1", port: 1 }) as never, connectDatabase: async () => ({ $disconnect: async () => undefined }) as never, buildRuntime: async () => { throw new Error(secret); }, installSignalHandlers: false, logger })).rejects.toThrow(secret);
    expect(records).toEqual([
      { event: STUDYMIND_EVENTS.startup, code: STUDYMIND_CODES.startup },
      { event: STUDYMIND_EVENTS.startupFailed, code: STUDYMIND_CODES.startupFailed },
    ]);
    expect(JSON.stringify(records)).not.toContain(secret);
  });

  test("signal shutdown emits ready, draining, shutdown without forcing a healthy exit", async () => {
    const records: unknown[] = []; const forceExit = vi.fn(); let signalHandler: ((signal: "SIGINT" | "SIGTERM") => Promise<void>) | undefined;
    const logger = createRuntimeLogger({ info: (record) => records.push(record), error: (record) => records.push(record) });
    await runServerLifecycle({ loadConfig: () => ({ host: "127.0.0.1", port: 8787 }) as never, connectDatabase: async () => ({ $disconnect: async () => undefined }) as never, buildRuntime: async () => ({ app: { listen: async () => undefined, close: async () => undefined }, readiness: { beginDraining: () => undefined } }) as never, registerSignalHandlers: (handler) => { signalHandler = handler; }, forceExit, logger });
    await signalHandler?.("SIGTERM");
    expect(records).toEqual([
      { event: STUDYMIND_EVENTS.startup, code: STUDYMIND_CODES.startup },
      { event: STUDYMIND_EVENTS.ready, code: STUDYMIND_CODES.ready },
      { event: STUDYMIND_EVENTS.draining, code: STUDYMIND_CODES.draining, signal: "SIGTERM" },
      { event: STUDYMIND_EVENTS.shutdown, code: STUDYMIND_CODES.shutdown, signal: "SIGTERM", exitCode: 0 },
    ]);
    expect(forceExit).not.toHaveBeenCalled();
  });

  test("non-timeout shutdown failures return nonzero without forcing exit", async () => {
    const forceExit = vi.fn(); const disconnect = vi.fn(async () => undefined);
    const shutdown = shutdownRuntime({ app: { close: async () => { throw new Error("close failed"); } }, prisma: { $disconnect: disconnect }, readiness: { beginDraining: () => undefined }, timeoutMs: 50, forceExit });
    expect(await shutdown("SIGTERM")).toEqual({ exitCode: 1, signal: "SIGTERM" });
    expect(disconnect).toHaveBeenCalledOnce();
    expect(forceExit).not.toHaveBeenCalled();
  });

  test("startup failure is logged before a hanging app close and preserves the original error", async () => {
    const records: unknown[] = []; const calls: string[] = []; const forceExit = vi.fn();
    const startupError = new Error("ORIGINAL_STARTUP_SECRET_CLOSE");
    const logger = createRuntimeLogger({ info: (record) => records.push(record), error: (record) => records.push(record) });
    let failureLoggedBeforeClose = false;
    const operation = runServerLifecycle({
      loadConfig: () => ({ host: "127.0.0.1", port: 8787 }) as never,
      connectDatabase: async () => ({ $disconnect: async () => { calls.push("disconnect"); } }) as never,
      buildRuntime: async () => ({ app: { listen: async () => { throw startupError; }, close: () => { calls.push("close"); failureLoggedBeforeClose = records.some((record) => (record as { event?: string }).event === STUDYMIND_EVENTS.startupFailed); return new Promise<void>(() => undefined); } }, readiness: { beginDraining: () => calls.push("draining") } }) as never,
      installSignalHandlers: false, shutdownTimeoutMs: 10, forceExit, logger,
    });
    const outcome = await Promise.race([operation.then(() => ({ status: "resolved" as const }), (error: unknown) => ({ status: "rejected" as const, error })), new Promise<{ status: "timed_out" }>((resolve) => setTimeout(() => resolve({ status: "timed_out" }), 100))]);
    expect(outcome).toEqual({ status: "rejected", error: startupError });
    expect(failureLoggedBeforeClose).toBe(true);
    expect(calls).toEqual(["draining", "close"]);
    expect(records).toEqual([{ event: STUDYMIND_EVENTS.startup, code: STUDYMIND_CODES.startup }, { event: STUDYMIND_EVENTS.startupFailed, code: STUDYMIND_CODES.startupFailed }]);
    expect(JSON.stringify(records)).not.toContain("ORIGINAL_STARTUP_SECRET_CLOSE");
    expect(forceExit).toHaveBeenCalledOnce(); expect(forceExit).toHaveBeenCalledWith(1);
  });

  test("startup cleanup gives a hanging disconnect only the remaining deadline", async () => {
    const records: unknown[] = []; const calls: string[] = []; const forceExit = vi.fn();
    const startupError = new Error("ORIGINAL_STARTUP_SECRET_DISCONNECT");
    const logger = createRuntimeLogger({ info: (record) => records.push(record), error: (record) => records.push(record) });
    let failureLoggedBeforeDisconnect = false;
    const operation = runServerLifecycle({
      loadConfig: () => ({ host: "127.0.0.1", port: 8787 }) as never,
      connectDatabase: async () => ({ $disconnect: () => { calls.push("disconnect"); failureLoggedBeforeDisconnect = records.some((record) => (record as { event?: string }).event === STUDYMIND_EVENTS.startupFailed); return new Promise<void>(() => undefined); } }) as never,
      buildRuntime: async () => ({ app: { listen: async () => { throw startupError; }, close: async () => { calls.push("close"); } }, readiness: { beginDraining: () => calls.push("draining") } }) as never,
      installSignalHandlers: false, shutdownTimeoutMs: 10, forceExit, logger,
    });
    const outcome = await Promise.race([operation.then(() => ({ status: "resolved" as const }), (error: unknown) => ({ status: "rejected" as const, error })), new Promise<{ status: "timed_out" }>((resolve) => setTimeout(() => resolve({ status: "timed_out" }), 100))]);
    expect(outcome).toEqual({ status: "rejected", error: startupError });
    expect(failureLoggedBeforeDisconnect).toBe(true);
    expect(calls).toEqual(["draining", "close", "disconnect"]);
    expect(records).toEqual([{ event: STUDYMIND_EVENTS.startup, code: STUDYMIND_CODES.startup }, { event: STUDYMIND_EVENTS.startupFailed, code: STUDYMIND_CODES.startupFailed }]);
    expect(JSON.stringify(records)).not.toContain("ORIGINAL_STARTUP_SECRET_DISCONNECT");
    expect(forceExit).toHaveBeenCalledOnce(); expect(forceExit).toHaveBeenCalledWith(1);
  });

  test("installs idempotent signals before blocked connect and prevents later listen", async () => {
    const calls: string[] = []; const forceExit = vi.fn(); const disconnect = vi.fn(async () => { calls.push("disconnect"); }); const removeListeners = vi.fn();
    let signalHandler: ((signal: "SIGINT" | "SIGTERM") => Promise<void>) | undefined;
    let releaseConnect: ((value: unknown) => void) | undefined;
    const blockedConnect = new Promise<unknown>((resolve) => { releaseConnect = resolve; });
    const operation = runServerLifecycle({
      loadConfig: () => ({ host: "127.0.0.1", port: 8787 }) as never,
      connectDatabase: async () => { calls.push("connect"); return await blockedConnect as never; },
      buildRuntime: async () => ({ app: { listen: async () => { calls.push("listen"); }, close: async () => { calls.push("close"); } }, readiness: { beginDraining: () => calls.push("draining") } }) as never,
      registerSignalHandlers: (handler) => { calls.push("register"); signalHandler = handler; return removeListeners; },
      shutdownTimeoutMs: 10, forceExit,
      logger: createRuntimeLogger({ info: () => undefined, error: () => undefined }),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (!signalHandler) {
      releaseConnect?.({ $disconnect: disconnect }); await operation;
      expect(calls.slice(0, 2)).toEqual(["register", "connect"]);
      return;
    }
    const first = signalHandler("SIGTERM"); const second = signalHandler("SIGINT");
    await Promise.all([first, second]);
    expect(forceExit).toHaveBeenCalledOnce(); expect(forceExit).toHaveBeenCalledWith(1);
    expect(removeListeners).toHaveBeenCalledOnce();
    releaseConnect?.({ $disconnect: disconnect });
    await expect(operation).rejects.toMatchObject({ name: "StartupInterruptedError" });
    expect(disconnect).toHaveBeenCalledOnce();
    expect(calls).toEqual(["register", "connect", "disconnect"]);
  });

  test("keeps signal listeners until a shared healthy shutdown settles", async () => {
    const handlers = new Set<(signal: "SIGINT" | "SIGTERM") => Promise<void>>(); const calls: string[] = []; const forceExit = vi.fn();
    let releaseClose: (() => void) | undefined; const close = new Promise<void>((resolve) => { releaseClose = resolve; });
    const runtime = await runServerLifecycle({
      loadConfig: () => ({ host: "127.0.0.1", port: 8787 }) as never,
      connectDatabase: async () => ({ $disconnect: async () => { calls.push("disconnect"); } }) as never,
      buildRuntime: async () => ({ app: { listen: async () => undefined, close: () => { calls.push("close"); return close; } }, readiness: { beginDraining: () => calls.push("draining") } }) as never,
      registerSignalHandlers: (handler) => { handlers.add(handler); return () => { handlers.delete(handler); }; },
      shutdownTimeoutMs: 100, forceExit, logger: createRuntimeLogger({ info: () => undefined, error: () => undefined }),
    });
    expect(handlers.size).toBe(1);
    const handler = [...handlers][0]!; const first = handler("SIGTERM");
    expect(handlers.size).toBe(1);
    const second = [...handlers][0]!("SIGINT");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(second).toBe(first); expect(calls).toEqual(["draining", "close"]); expect(forceExit).not.toHaveBeenCalled();
    releaseClose?.(); await Promise.all([first, second]);
    expect(handlers.size).toBe(0); expect(calls).toEqual(["draining", "close", "disconnect"]);
    await runtime.shutdown("test");
  });

  test("reports a rejected late database cleanup as failed without forcing exit", async () => {
    const records: unknown[] = []; const forceExit = vi.fn(); const originalExitCode = process.exitCode; let handler: ((signal: "SIGINT" | "SIGTERM") => Promise<void>) | undefined; let releaseConnect: ((value: unknown) => void) | undefined;
    const blocked = new Promise<unknown>((resolve) => { releaseConnect = resolve; });
    const operation = runServerLifecycle({ loadConfig: () => ({ host: "127.0.0.1", port: 8787 }) as never, connectDatabase: async () => await blocked as never, buildRuntime: async () => { throw new Error("must not build"); }, registerSignalHandlers: (value) => { handler = value; }, shutdownTimeoutMs: 100, forceExit, logger: createRuntimeLogger({ info: (record) => records.push(record), error: (record) => records.push(record) }) });
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      const handling = handler!("SIGTERM"); releaseConnect?.({ $disconnect: async () => { throw new Error("DATABASE_CLEANUP_SECRET"); } });
      await expect(operation).rejects.toMatchObject({ name: "StartupInterruptedError" }); await handling;
      expect(process.exitCode).toBe(1); expect(forceExit).not.toHaveBeenCalled();
      expect(records).toContainEqual({ event: STUDYMIND_EVENTS.cleanupFailed, code: STUDYMIND_CODES.cleanupFailed, phase: "startup_signal", resource: "database" });
      expect(JSON.stringify(records)).not.toContain("DATABASE_CLEANUP_SECRET");
    } finally { process.exitCode = originalExitCode; }
  });

  test("reports a rejected app close during interrupted startup and still disconnects", async () => {
    const records: unknown[] = []; const forceExit = vi.fn(); const disconnect = vi.fn(async () => undefined); const originalExitCode = process.exitCode; let handler: ((signal: "SIGINT" | "SIGTERM") => Promise<void>) | undefined; let releaseListen: (() => void) | undefined;
    const listen = new Promise<void>((resolve) => { releaseListen = resolve; });
    const operation = runServerLifecycle({ loadConfig: () => ({ host: "127.0.0.1", port: 8787 }) as never, connectDatabase: async () => ({ $disconnect: disconnect }) as never, buildRuntime: async () => ({ app: { listen: () => listen, close: async () => { throw new Error("APP_CLOSE_SECRET"); } }, readiness: { beginDraining: () => undefined } }) as never, registerSignalHandlers: (value) => { handler = value; }, shutdownTimeoutMs: 100, forceExit, logger: createRuntimeLogger({ info: (record) => records.push(record), error: (record) => records.push(record) }) });
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      const handling = handler!("SIGINT"); releaseListen?.();
      await expect(operation).rejects.toMatchObject({ name: "StartupInterruptedError" }); await handling;
      expect(process.exitCode).toBe(1); expect(forceExit).not.toHaveBeenCalled(); expect(disconnect).toHaveBeenCalledOnce();
      expect(records).toContainEqual({ event: STUDYMIND_EVENTS.cleanupFailed, code: STUDYMIND_CODES.cleanupFailed, phase: "startup_signal", resource: "application" });
      expect(JSON.stringify(records)).not.toContain("APP_CLOSE_SECRET");
    } finally { process.exitCode = originalExitCode; }
  });

  test("keeps real repeated SIGTERM delivery active until blocked shutdown settles", async () => {
    const baselineTerm = process.listenerCount("SIGTERM"); const baselineInt = process.listenerCount("SIGINT"); const calls: string[] = []; const forceExit = vi.fn(); let releaseClose: (() => void) | undefined;
    const close = new Promise<void>((resolve) => { releaseClose = resolve; });
    const runtime = await runServerLifecycle({ loadConfig: () => ({ host: "127.0.0.1", port: 8787 }) as never, connectDatabase: async () => ({ $disconnect: async () => { calls.push("disconnect"); } }) as never, buildRuntime: async () => ({ app: { listen: async () => undefined, close: () => { calls.push("close"); return close; } }, readiness: { beginDraining: () => calls.push("draining") } }) as never, shutdownTimeoutMs: 100, forceExit, logger: createRuntimeLogger({ info: () => undefined, error: () => undefined }) });
    expect(process.listenerCount("SIGTERM")).toBe(baselineTerm + 1); expect(process.listenerCount("SIGINT")).toBe(baselineInt + 1);
    process.emit("SIGTERM", "SIGTERM"); process.emit("SIGTERM", "SIGTERM");
    const duringTerm = process.listenerCount("SIGTERM"); const duringInt = process.listenerCount("SIGINT");
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseClose?.(); await runtime.shutdown("SIGTERM"); await new Promise<void>((resolve) => setImmediate(resolve));
    expect(duringTerm).toBe(baselineTerm + 1); expect(duringInt).toBe(baselineInt + 1);
    expect(process.listenerCount("SIGTERM")).toBe(baselineTerm); expect(process.listenerCount("SIGINT")).toBe(baselineInt);
    expect(calls).toEqual(["draining", "close", "disconnect"]); expect(forceExit).not.toHaveBeenCalled();
  });

  test("settles signal handling when blocked connect rejects without timeout force", async () => {
    const records: unknown[] = []; const forceExit = vi.fn(); const removeListeners = vi.fn(); const originalExitCode = process.exitCode; let handler: ((signal: "SIGINT" | "SIGTERM") => Promise<void>) | undefined; let rejectConnect: ((error: Error) => void) | undefined;
    const connect = new Promise<never>((_resolve, reject) => { rejectConnect = reject; }); const original = new Error("CONNECT_STAGE_SECRET");
    const operation = runServerLifecycle({ loadConfig: () => ({ host: "127.0.0.1", port: 8787 }) as never, connectDatabase: async () => await connect, buildRuntime: async () => { throw new Error("must not build"); }, registerSignalHandlers: (value) => { handler = value; return removeListeners; }, shutdownTimeoutMs: 100, forceExit, logger: createRuntimeLogger({ info: (record) => records.push(record), error: (record) => records.push(record) }) });
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      const handling = handler!("SIGTERM"); rejectConnect?.(original);
      await expect(operation).rejects.toBe(original); await handling;
      expect(process.exitCode).toBe(1); expect(forceExit).not.toHaveBeenCalled(); expect(removeListeners).toHaveBeenCalledOnce();
      expect(records).toContainEqual({ event: STUDYMIND_EVENTS.startupFailed, code: STUDYMIND_CODES.startupFailed }); expect(JSON.stringify(records)).not.toContain("CONNECT_STAGE_SECRET");
    } finally { process.exitCode = originalExitCode; }
  });

  test("cleans once and settles signal handling when listen rejects", async () => {
    const records: unknown[] = []; const forceExit = vi.fn(); const disconnect = vi.fn(async () => undefined); const close = vi.fn(async () => undefined); const removeListeners = vi.fn(); const originalExitCode = process.exitCode; let handler: ((signal: "SIGINT" | "SIGTERM") => Promise<void>) | undefined; let rejectListen: ((error: Error) => void) | undefined;
    const listen = new Promise<never>((_resolve, reject) => { rejectListen = reject; }); const original = new Error("LISTEN_STAGE_SECRET");
    const operation = runServerLifecycle({ loadConfig: () => ({ host: "127.0.0.1", port: 8787 }) as never, connectDatabase: async () => ({ $disconnect: disconnect }) as never, buildRuntime: async () => ({ app: { listen: () => listen, close }, readiness: { beginDraining: () => undefined } }) as never, registerSignalHandlers: (value) => { handler = value; return removeListeners; }, shutdownTimeoutMs: 100, forceExit, logger: createRuntimeLogger({ info: (record) => records.push(record), error: (record) => records.push(record) }) });
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      const handling = handler!("SIGINT"); rejectListen?.(original);
      await expect(operation).rejects.toBe(original); await handling;
      expect(process.exitCode).toBe(1); expect(forceExit).not.toHaveBeenCalled(); expect(removeListeners).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce(); expect(disconnect).toHaveBeenCalledOnce();
      expect(records).toContainEqual({ event: STUDYMIND_EVENTS.startupFailed, code: STUDYMIND_CODES.startupFailed }); expect(JSON.stringify(records)).not.toContain("LISTEN_STAGE_SECRET");
    } finally { process.exitCode = originalExitCode; }
  });
});
