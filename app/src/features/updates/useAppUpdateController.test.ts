import { describe, expect, test, vi } from "vitest";

import {
  logSafeUpdateWarning,
  type UpdateWarningCode,
} from "./useAppUpdateController";

describe("safe update diagnostics", () => {
  test("logs only a stable code and allowlisted technical fields", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sensitiveError = Object.assign(
      new Error(
        "Request to https://updates.example.test/feed?token=super-secret failed " +
          "for D:/Users/alice/private/update.json with HTTP status 503 and errno ENOENT",
      ),
      { code: "UPDATE_HTTP_FAILURE" },
    );
    const warningCodes: UpdateWarningCode[] = [
      "UPDATE_PREFERENCES_SAVE_FAILED",
      "UPDATE_PREFERENCES_LOAD_FAILED",
      "UPDATE_DELIVERY_LOAD_FAILED",
    ];

    for (const code of warningCodes) {
      logSafeUpdateWarning(code, sensitiveError);
    }

    for (const [index, code] of warningCodes.entries()) {
      expect(warn).toHaveBeenNthCalledWith(index + 1, code, {
        errorCode: "UPDATE_HTTP_FAILURE",
        httpStatus: 503,
        errno: "ENOENT",
      });
    }
    const serializedCalls = JSON.stringify(warn.mock.calls);
    expect(serializedCalls).not.toContain("super-secret");
    expect(serializedCalls).not.toContain("https://");
    expect(serializedCalls).not.toContain("D:/Users/alice");
    expect(serializedCalls).not.toContain("token=");

    warn.mockRestore();
  });
});
