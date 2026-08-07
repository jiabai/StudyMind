import { describe, expect, test } from "vitest";
import {
  IpcProtocolError,
  readIpcDataArray,
  readIpcDataObject,
} from "./tauriIpcProtocol";

const ERROR_CODE = "SETTINGS_IPC_RESPONSE_INVALID" as const;

describe("Tauri IPC protocol primitives", () => {
  test("reads exact own data properties from ordinary objects", () => {
    expect(
      readIpcDataObject(
        { required: "value", optional: null },
        ["required"],
        ["optional"],
        ERROR_CODE,
      ),
    ).toEqual({ required: "value", optional: null });

    const nullPrototype = Object.create(null) as Record<string, unknown>;
    nullPrototype.required = 1;
    expect(
      readIpcDataObject(
        nullPrototype,
        ["required"],
        [],
        ERROR_CODE,
      ),
    ).toEqual({ required: 1 });
  });

  test.each([
    null,
    undefined,
    "value",
    42,
    [],
    new Date(),
  ])("rejects non-data-object response %#", (value) => {
    expect(() =>
      readIpcDataObject(value, [], [], ERROR_CODE),
    ).toThrowError(new IpcProtocolError(ERROR_CODE));
  });

  test("rejects missing, unknown, and symbol properties", () => {
    expect(() =>
      readIpcDataObject({}, ["required"], [], ERROR_CODE),
    ).toThrowError(new IpcProtocolError(ERROR_CODE));
    expect(() =>
      readIpcDataObject(
        { required: true, unexpected: true },
        ["required"],
        [],
        ERROR_CODE,
      ),
    ).toThrowError(new IpcProtocolError(ERROR_CODE));

    const withSymbol = { required: true } as Record<PropertyKey, unknown>;
    withSymbol[Symbol("secret")] = "not allowed";
    expect(() =>
      readIpcDataObject(withSymbol, ["required"], [], ERROR_CODE),
    ).toThrowError(new IpcProtocolError(ERROR_CODE));
  });

  test("rejects accessors without evaluating them or echoing their values", () => {
    const secret = "C:\\Users\\private\\transcript.txt";
    let getterCalls = 0;
    const response = Object.defineProperty({}, "required", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error(secret);
      },
    });

    let captured: unknown;
    try {
      readIpcDataObject(response, ["required"], [], ERROR_CODE);
    } catch (error) {
      captured = error;
    }

    expect(getterCalls).toBe(0);
    expect(captured).toBeInstanceOf(IpcProtocolError);
    expect(captured).toMatchObject({
      name: "IpcProtocolError",
      message: ERROR_CODE,
      code: ERROR_CODE,
    });
    expect(JSON.stringify(captured)).not.toContain(secret);
    expect((captured as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  test("maps reflection failures to the stable code without exposing the cause", () => {
    const secret = "user@example.com";
    const response = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error(secret);
        },
      },
    );

    expect(() =>
      readIpcDataObject(response, [], [], ERROR_CODE),
    ).toThrowError(new IpcProtocolError(ERROR_CODE));

    try {
      readIpcDataObject(response, [], [], ERROR_CODE);
    } catch (error) {
      expect(String(error)).not.toContain(secret);
      expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    }
  });

  test("reads dense data arrays and rejects sparse, custom, or accessor entries", () => {
    expect(readIpcDataArray(["first", 2], ERROR_CODE)).toEqual(["first", 2]);

    const sparse = new Array(1);
    expect(() => readIpcDataArray(sparse, ERROR_CODE)).toThrowError(
      new IpcProtocolError(ERROR_CODE),
    );

    const custom = ["first"] as unknown[] & { extra?: string };
    custom.extra = "not allowed";
    expect(() => readIpcDataArray(custom, ERROR_CODE)).toThrowError(
      new IpcProtocolError(ERROR_CODE),
    );

    let getterCalls = 0;
    const accessor = ["first"];
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "secret";
      },
    });
    expect(() => readIpcDataArray(accessor, ERROR_CODE)).toThrowError(
      new IpcProtocolError(ERROR_CODE),
    );
    expect(getterCalls).toBe(0);
  });
});
