import "dotenv/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runServerLifecycle, StartupInterruptedError } from "./bootstrap.js";
import { createRuntimeLogger } from "./observability.js";

export async function main(): Promise<void> {
  await runServerLifecycle({
    logger: createRuntimeLogger(),
    developmentOtpWriter: (email, code) => { process.stderr.write(`[StudyMind development OTP] ${email}: ${code}\n`); },
  });
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry && fileURLToPath(import.meta.url) === entry) {
  main().catch((error) => { if (!(error instanceof StartupInterruptedError)) process.exitCode = 1; });
}
