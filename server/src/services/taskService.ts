import { prisma } from "../lib/prisma.js";
import type { Prisma } from "@prisma/client";

export type CreateTaskInput = {
  taskId: string;
  platform?: string;
  sourceKind?: string;
  sourceDisplay?: string;
  sourceMediaKind?: string;
  sourceExtension?: string;
  model?: string;
  appVersion?: string;
  status?: string;
};

export type UpdateTaskInput = {
  status?: string;
  stage?: string;
  completedAt?: Date | null;
  textPreview?: string;
  insightsCount?: number;
  transcript?: string | null;
  artifacts?: string | null;
  error?: string | null;
  insights?: string | null;
  dissection?: string | null;
  preferenceSnapshot?: string | null;
  extra?: string | null;
};

export type ListTasksQuery = {
  status?: string;
  stage?: string;
  limit?: number;
  offset?: number;
};

export async function createTask(input: CreateTaskInput) {
  return prisma.task.create({
    data: {
      taskId: input.taskId,
      status: input.status ?? "pending",
      platform: input.platform ?? "local",
      sourceKind: input.sourceKind,
      sourceDisplay: input.sourceDisplay,
      sourceMediaKind: input.sourceMediaKind,
      sourceExtension: input.sourceExtension,
      model: input.model ?? "",
      appVersion: input.appVersion ?? "0.1.0",
    },
  });
}

export async function getTaskByTaskId(taskId: string) {
  return prisma.task.findUnique({
    where: { taskId },
    include: {
      progress: { orderBy: { createdAt: "desc" }, take: 1 },
      aiGenerations: { orderBy: { createdAt: "desc" } },
    },
  });
}

export async function listTasks(query: ListTasksQuery = {}) {
  const where: Prisma.TaskWhereInput = {};

  if (query.status) where.status = query.status;
  if (query.stage) where.stage = query.stage;

  const [tasks, total] = await Promise.all([
    prisma.task.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: query.limit ?? 50,
      skip: query.offset ?? 0,
    }),
    prisma.task.count({ where }),
  ]);

  return { tasks, total };
}

export async function updateTask(taskId: string, input: UpdateTaskInput) {
  const task = await prisma.task.findUnique({ where: { taskId } });
  if (!task) return null;

  const data: Prisma.TaskUncheckedUpdateInput = {};

  if (input.status !== undefined) data.status = input.status;
  if (input.stage !== undefined) data.stage = input.stage;
  if (input.completedAt !== undefined) data.completedAt = input.completedAt;
  if (input.textPreview !== undefined) data.textPreview = input.textPreview;
  if (input.insightsCount !== undefined) data.insightsCount = input.insightsCount;
  if (input.transcript !== undefined) data.transcript = input.transcript;
  if (input.artifacts !== undefined) data.artifacts = input.artifacts;
  if (input.error !== undefined) data.error = input.error;
  if (input.insights !== undefined) data.insights = input.insights;
  if (input.dissection !== undefined) data.dissection = input.dissection;
  if (input.preferenceSnapshot !== undefined) data.preferenceSnapshot = input.preferenceSnapshot;
  if (input.extra !== undefined) data.extra = input.extra;

  return prisma.task.update({
    where: { taskId },
    data,
    include: {
      progress: { orderBy: { createdAt: "desc" }, take: 1 },
      aiGenerations: { orderBy: { createdAt: "desc" } },
    },
  });
}

export async function deleteTask(taskId: string) {
  const task = await prisma.task.findUnique({ where: { taskId } });
  if (!task) return null;
  return prisma.task.delete({ where: { taskId } });
}

export async function getTaskProgress(taskId: string, limit = 100) {
  return prisma.taskProgress.findMany({
    where: { taskId },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
}

export async function createTaskProgress(
  taskId: string,
  data: { stage: string; progress: number; messageCode: string; messageArgs?: string | null },
) {
  return prisma.taskProgress.create({
    data: {
      taskId,
      stage: data.stage,
      progress: data.progress,
      messageCode: data.messageCode,
      messageArgs: data.messageArgs ?? null,
    },
  });
}

export async function createAiGeneration(
  taskId: string,
  data: { target: string; outputLanguage: string; preferenceSnapshot?: string | null },
) {
  return prisma.aiGeneration.create({
    data: {
      taskId,
      target: data.target,
      status: "pending",
      outputLanguage: data.outputLanguage,
      preferenceSnapshot: data.preferenceSnapshot ?? null,
    },
  });
}

export async function updateAiGeneration(
  id: string,
  data: {
    status?: string;
    result?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    retryAttempts?: number;
  },
) {
  const updateData: Prisma.AiGenerationUncheckedUpdateInput = {};
  if (data.status) updateData.status = data.status;
  if (data.result !== undefined) updateData.result = data.result;
  if (data.errorCode !== undefined) updateData.errorCode = data.errorCode;
  if (data.errorMessage !== undefined) updateData.errorMessage = data.errorMessage;
  if (data.retryAttempts !== undefined) updateData.retryAttempts = data.retryAttempts;

  return prisma.aiGeneration.update({ where: { id }, data: updateData });
}

export async function createWorkerCommand(
  taskId: string | null,
  data: { command: string; request?: string | null },
) {
  return prisma.workerCommand.create({
    data: {
      taskId,
      command: data.command,
      status: "pending",
      request: data.request ?? null,
    },
  });
}

export async function updateWorkerCommand(
  id: string,
  data: {
    status?: string;
    result?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    startedAt?: Date | null;
    completedAt?: Date | null;
  },
) {
  const updateData: Prisma.WorkerCommandUncheckedUpdateInput = {};
  if (data.status) updateData.status = data.status;
  if (data.result !== undefined) updateData.result = data.result;
  if (data.errorCode !== undefined) updateData.errorCode = data.errorCode;
  if (data.errorMessage !== undefined) updateData.errorMessage = data.errorMessage;
  if (data.startedAt !== undefined) updateData.startedAt = data.startedAt;
  if (data.completedAt !== undefined) updateData.completedAt = data.completedAt;

  return prisma.workerCommand.update({ where: { id }, data: updateData });
}