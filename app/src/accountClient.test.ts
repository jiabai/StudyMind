import { describe, expect, test } from "vitest";
import { getServerBaseUrl, type AccountCommandRunner } from "./accountClient";
import { IpcProtocolError } from "./tauriIpcProtocol";

describe("account client server base URL", () => {
  test("loads the configured server base URL from Tauri", async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    const runner: AccountCommandRunner = async (command, args) => {
      calls.push({ command, args });
      return "http://127.0.0.1:8787";
    };

    const baseUrl = await getServerBaseUrl(runner);

    expect(calls).toEqual([{ command: "get_server_base_url", args: {} }]);
    expect(baseUrl).toBe("http://127.0.0.1:8787");
  });

  test("rejects empty or non-string server base URLs", async () => {
    for (const value of ["", 42, null, {}]) {
      const runner: AccountCommandRunner = async () => value;
      await expect(getServerBaseUrl(runner)).rejects.toBeInstanceOf(
        IpcProtocolError,
      );
    }
  });
});
