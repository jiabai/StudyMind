import "dotenv/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runServerLifecycle } from "./bootstrap.js";
import { createRuntimeLogger } from "./observability.js";

export async function main(): Promise<void> {
  await runServerLifecycle({ logger: createRuntimeLogger() });
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry && fileURLToPath(import.meta.url) === entry) {
  main().catch(() => { process.exitCode = 1; });
}
