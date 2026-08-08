import type { Store } from "../contracts.js";
import type { MemoryAuthContext } from "./auth.js";

export async function getLlmConfig(
  context: MemoryAuthContext,
): ReturnType<Store["getLlmConfig"]> { return context.state.llmConfig; }

export async function upsertLlmConfig(
  context: MemoryAuthContext, input: Parameters<Store["upsertLlmConfig"]>[0], now: Date,
): ReturnType<Store["upsertLlmConfig"]> {
  if (context.state.llmConfig) {
    context.state.llmConfig = { ...context.state.llmConfig, ...input, updatedAt: now };
  } else {
    context.state.llmConfig = { ...input, id: context.allocateId(), createdAt: now, updatedAt: now };
  }
  return context.state.llmConfig;
}
