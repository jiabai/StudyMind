import type { FastifyInstance } from "fastify";
import type { Readiness } from "../readiness.js";

export function registerHealthRoutes(app: FastifyInstance, readiness: Readiness): void {
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_request, reply) => await readiness.isReady() ? { status: "ok" } : reply.code(503).send({ status: "unavailable" }));
}
