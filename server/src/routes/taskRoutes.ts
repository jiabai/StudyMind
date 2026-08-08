import { z } from "zod";
import {
  createTask,
  getTaskByTaskId,
  listTasks,
  updateTask,
  deleteTask,
  getTaskProgress,
} from "../services/taskService.js";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

const createTaskSchema = z.object({
  taskId: z.string().min(1).max(255),
  platform: z.string().optional(),
  sourceKind: z.string().optional(),
  sourceDisplay: z.string().optional(),
  sourceMediaKind: z.enum(["audio", "video"]).optional(),
  sourceExtension: z.string().optional(),
  model: z.string().optional(),
});

const updateTaskSchema = z.object({
  status: z.string().optional(),
  stage: z.string().optional(),
  completedAt: z.string().datetime().optional().nullable(),
  textPreview: z.string().optional(),
  insightsCount: z.number().int().optional(),
  transcript: z.string().optional().nullable(),
  artifacts: z.string().optional().nullable(),
  error: z.string().optional().nullable(),
  insights: z.string().optional().nullable(),
  dissection: z.string().optional().nullable(),
  preferenceSnapshot: z.string().optional().nullable(),
  extra: z.string().optional().nullable(),
});

const listQuerySchema = z.object({
  status: z.string().optional(),
  stage: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const taskIdParamsSchema = z.object({
  taskId: z.string().min(1).max(255),
});

export async function taskRoutes(app: FastifyInstance) {
  app.post("/", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = createTaskSchema.parse(request.body);
      const task = await createTask(body);
      reply.code(201).send(task);
    } catch (err) {
      if (err instanceof z.ZodError) {
        reply.code(400).send({ error: "Validation failed", details: err.errors });
        return;
      }
      reply.code(500).send({ error: "Failed to create task" });
    }
  });

  app.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const query = listQuerySchema.parse(request.query);
      const result = await listTasks(query);
      reply.send(result);
    } catch (err) {
      if (err instanceof z.ZodError) {
        reply.code(400).send({ error: "Invalid query parameters", details: err.errors });
        return;
      }
      reply.code(500).send({ error: "Failed to list tasks" });
    }
  });

  app.get("/:taskId", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { taskId } = taskIdParamsSchema.parse(request.params);
      const task = await getTaskByTaskId(taskId);
      if (!task) {
        reply.code(404).send({ error: "Task not found" });
        return;
      }
      reply.send(task);
    } catch (err) {
      if (err instanceof z.ZodError) {
        reply.code(400).send({ error: "Invalid task ID" });
        return;
      }
      reply.code(500).send({ error: "Failed to get task" });
    }
  });

  app.patch("/:taskId", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { taskId } = taskIdParamsSchema.parse(request.params);
      const body = updateTaskSchema.parse(request.body);

      const completedAt = body.completedAt
        ? new Date(body.completedAt)
        : undefined;

      const task = await updateTask(taskId, {
        ...body,
        completedAt,
      });
      if (!task) {
        reply.code(404).send({ error: "Task not found" });
        return;
      }
      reply.send(task);
    } catch (err) {
      if (err instanceof z.ZodError) {
        reply.code(400).send({ error: "Validation failed", details: err.errors });
        return;
      }
      reply.code(500).send({ error: "Failed to update task" });
    }
  });

  app.delete("/:taskId", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { taskId } = taskIdParamsSchema.parse(request.params);
      const task = await deleteTask(taskId);
      if (!task) {
        reply.code(404).send({ error: "Task not found" });
        return;
      }
      reply.code(204).send();
    } catch (err) {
      if (err instanceof z.ZodError) {
        reply.code(400).send({ error: "Invalid task ID" });
        return;
      }
      reply.code(500).send({ error: "Failed to delete task" });
    }
  });

  app.get("/:taskId/progress", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { taskId } = taskIdParamsSchema.parse(request.params);
      const progress = await getTaskProgress(taskId);
      reply.send({ taskId, progress });
    } catch (err) {
      if (err instanceof z.ZodError) {
        reply.code(400).send({ error: "Invalid task ID" });
        return;
      }
      reply.code(500).send({ error: "Failed to get task progress" });
    }
  });
}