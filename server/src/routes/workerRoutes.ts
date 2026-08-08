import { z } from "zod";
import {
  createWorkerCommand,
  updateWorkerCommand,
} from "../services/taskService.js";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

const workerCommandSchema = z.object({
  taskId: z.string().min(1).nullable().optional(),
  command: z.enum(["process_local_media", "retry_insights", "download_asr_model"]),
  request: z.record(z.unknown()).optional().nullable(),
});

const workerResultSchema = z.object({
  status: z.enum(["completed", "partial_completed", "failed"]),
  taskId: z.string().nullable().optional(),
  taskDir: z.string().nullable().optional(),
  artifacts: z.record(z.string()).optional(),
  text: z.string().optional(),
  summary: z.string().optional(),
  insights: z.array(z.unknown()).optional(),
  transcript: z.record(z.unknown()).nullable().optional(),
  dissection: z.record(z.unknown()).nullable().optional(),
  error: z.record(z.unknown()).nullable().optional(),
});

export async function workerRoutes(app: FastifyInstance) {
  app.post("/commands", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = workerCommandSchema.parse(request.body);

      const command = await createWorkerCommand(body.taskId ?? null, {
        command: body.command,
        request: body.request ? JSON.stringify(body.request) : null,
      });

      reply.code(202).send(command);
    } catch (err) {
      if (err instanceof z.ZodError) {
        reply.code(400).send({ error: "Validation failed", details: err.errors });
        return;
      }
      reply.code(500).send({ error: "Failed to create worker command" });
    }
  });

  app.post("/commands/:id/result", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string };
      const body = workerResultSchema.parse(request.body);

      const result = await updateWorkerCommand(id, {
        status: body.status,
        result: JSON.stringify(body),
        completedAt: new Date(),
      });

      if (!result) {
        reply.code(404).send({ error: "Worker command not found" });
        return;
      }

      reply.send(result);
    } catch (err) {
      if (err instanceof z.ZodError) {
        reply.code(400).send({ error: "Validation failed", details: err.errors });
        return;
      }
      reply.code(500).send({ error: "Failed to update worker command" });
    }
  });

  app.get("/commands/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string };
      const { prisma } = await import("../lib/prisma.js");
      const command = await prisma.workerCommand.findUnique({ where: { id } });
      if (!command) {
        reply.code(404).send({ error: "Worker command not found" });
        return;
      }
      reply.send(command);
    } catch {
      reply.code(500).send({ error: "Failed to get worker command" });
    }
  });
}