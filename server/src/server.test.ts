import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestDatabase, type TestDatabase } from "./testDatabase.js";

let database: TestDatabase;
let server: FastifyInstance;

beforeAll(async () => {
  database = createTestDatabase();
  await database.reset();

  const { createServer } = await import("./server.js");
  server = await createServer();
});

afterAll(async () => {
  await server?.close();
  await database?.close();
});

describe("server", () => {
  it("reports the live health status", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/health/live",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });
});
