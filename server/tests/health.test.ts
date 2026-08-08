import Fastify from "fastify";
import { describe, expect, test } from "vitest";
import { Readiness } from "../src/readiness.js";
import { registerHealthRoutes } from "../src/routes/health.js";

describe("health endpoints", () => {
  test("liveness reports only process state while readiness is fail closed", async () => {
    const readiness = new Readiness({ probe: async () => false });
    const app = Fastify(); registerHealthRoutes(app, readiness);
    expect((await app.inject("/health/live")).json()).toEqual({ status: "ok" });
    const ready = await app.inject("/health/ready");
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ status: "unavailable" });
  });

  test("draining overrides a successful database probe", async () => {
    const readiness = new Readiness({ probe: async () => true });
    await readiness.verifyStartup();
    const app = Fastify(); registerHealthRoutes(app, readiness);
    expect((await app.inject("/health/ready")).statusCode).toBe(200);
    readiness.beginDraining();
    expect((await app.inject("/health/ready")).statusCode).toBe(503);
  });
});
