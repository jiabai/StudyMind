import { describe, expect, test, vi } from "vitest";
import { runServerLifecycle, shutdownRuntime } from "../src/bootstrap.js";

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

  test("shutdown is idempotent and returns a nonzero result on timeout", async () => {
    const draining = vi.fn(); const disconnect = vi.fn(async () => undefined);
    const never = new Promise<void>(() => undefined);
    const shutdown = shutdownRuntime({ app: { close: () => never }, prisma: { $disconnect: disconnect }, readiness: { beginDraining: draining }, timeoutMs: 5 });
    const [first, second] = await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT")]);
    expect(first.exitCode).toBe(1); expect(second).toBe(first); expect(draining).toHaveBeenCalledOnce(); expect(disconnect).toHaveBeenCalledOnce();
  });
});
