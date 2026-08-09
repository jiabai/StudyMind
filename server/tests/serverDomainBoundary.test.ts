import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const schemaPath = fileURLToPath(new URL("../prisma/schema.prisma", import.meta.url));
const schema = readFileSync(schemaPath, "utf8");
const modelNames = Array.from(schema.matchAll(/^\s*model\s+(\w+)\s*\{/gm), (match) => match[1]);

const accountModels = [
  "User",
  "EmailOtp",
  "AuthRateLimit",
  "DesktopLoginTicket",
  "Session",
  "Order",
  "Entitlement",
  "LlmConfig",
  "LlmUsageEvent",
  "ActivationCode",
  "AdminSession",
  "UserSession",
  "AdminEntitlementAdjustment",
  "WebhookEvent",
];

describe("server domain boundary", () => {
  test("contains exactly the account, authentication, entitlement, and billing models", () => {
    expect(modelNames).toEqual(accountModels);
  });

  test.each(["Task", "TaskProgress", "AiGeneration", "AsrModel", "WorkerCommand"])(
    "does not contain the legacy processing model %s",
    (legacyModel) => {
      expect(modelNames).not.toContain(legacyModel);
    },
  );
});
