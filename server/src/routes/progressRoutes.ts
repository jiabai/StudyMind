import { z } from "zod";
import { createTaskProgress } from "../services/taskService.js";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { EventEmitter } from "node:events";

const progressEmitter = new EventEmitter();

const progressEventSchema = z.object({
  taskId: z.string().min(1),
  stage: z.enum([
    "waiting_input",
    "video_extracting",
    "video_transcribing",
    "insights_generating",
    "completed",
    "partial_completed",
    "failed",
  ]),
  progress: z.number().min(0).max(100),
  messageCode: z.string().min(1),
  messageArgs: z.record(z.unknown()).optional().nullable(),
});

export async function progressRoutes(app: FastifyInstance) {
  app.post("/", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = progressEventSchema.parse(request.body);

      const progress = await createTaskProgress(body.taskId, {
        stage: body.stage,
        progress: body.progress,
        messageCode: body.messageCode,
        messageArgs: body.messageArgs ? JSON.stringify(body.messageArgs) : null,
      });

      progressEmitter.emit(`progress:${body.taskId}`, progress);

      reply.code(201).send(progress);
    } catch (err) {
      if (err instanceof z.ZodError) {
        reply.code(400).send({ error: "Validation failed", details: err.errors });
        return;
      }
      reply.code(500).send({ error: "Failed to record progress" });
    }
  });

  app.get("/:taskId/stream", async (request: FastifyRequest, reply: FastifyReply) => {
    const { taskId } = request.params as { taskId: string };

    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("Access-Control-Allow-Origin", "*");

    reply.hijack();

    const sendEvent = (data: unknown) => {
      try {
        const payload = `data: ${JSON.stringify(data)}\n\n`;
        reply.raw.write(payload);
      } catch {
        // Client may have disconnected
      }
    };

    sendEvent({ type: "connected", taskId });

    const handler = (progress: unknown) => {
      sendEvent({ type: "progress", data: progress });
    };

    progressEmitter.on(`progress:${taskId}`, handler);

    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(": heartbeat\n\n");
      } catch {
        cleanup();
      }
    }, 30000);

    const cleanup = () => {
      progressEmitter.removeListener(`progress:${taskId}`, handler);
      clearInterval(heartbeat);
      reply.raw.end();
    };

    request.raw.on("close", cleanup);
    request.raw.on("error", cleanup);
  });
}

export { progressEmitter };