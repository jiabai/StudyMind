import type { PrismaClient } from "@prisma/client";
import type { LlmConfigRecord, Store } from "../store/contracts.js";
export async function getLlmConfig(prisma: PrismaClient): ReturnType<Store["getLlmConfig"]> { return await prisma.llmConfig.findUnique({ where: { id: "default" } }) as LlmConfigRecord | null; }
export async function upsertLlmConfig(prisma: PrismaClient, input: Parameters<Store["upsertLlmConfig"]>[0], now: Date): ReturnType<Store["upsertLlmConfig"]> { return await prisma.llmConfig.upsert({ where: { id: "default" }, update: { ...input, updatedAt: now }, create: { ...input, id: "default", createdAt: now, updatedAt: now } }) as LlmConfigRecord; }
