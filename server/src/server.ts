import Fastify from "fastify";
import { taskRoutes } from "./routes/taskRoutes.js";
import { progressRoutes } from "./routes/progressRoutes.js";
import { workerRoutes } from "./routes/workerRoutes.js";

export async function createServer() {
  const server = Fastify({
    logger: true,
  });

  server.addHook("onRequest", async (request, reply) => {
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    reply.header("Access-Control-Allow-Headers", "Content-Type,Authorization");
  });

  server.setErrorHandler((error: Error, request, reply) => {
    request.log.error(error);
    reply.code(500).send({ error: error.message });
  });

  server.get("/health/live", async () => ({ status: "ok" }));

  server.get("/health/ready", async () => {
    return { status: "ok", timestamp: new Date().toISOString() };
  });

  server.register(taskRoutes, { prefix: "/api/tasks" });
  server.register(progressRoutes, { prefix: "/api/progress" });
  server.register(workerRoutes, { prefix: "/api/workers" });

  return server;
}