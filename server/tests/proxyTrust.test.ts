import { describe, expect, test } from "vitest";
import { isLoopbackProxy } from "../src/server.js";

describe("proxy trust", () => {
  test.each(["127.0.0.1", "::1", "::ffff:127.0.0.1"])("trusts loopback proxy %s", (address) => expect(isLoopbackProxy(address)).toBe(true));
  test.each(["10.0.0.1", "192.168.1.10", "::ffff:10.0.0.1", "8.8.8.8", undefined])("rejects non-loopback proxy %s", (address) => expect(isLoopbackProxy(address)).toBe(false));
});
