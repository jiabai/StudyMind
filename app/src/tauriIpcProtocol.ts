export type IpcProtocolErrorCode =
  | "ACCOUNT_IPC_RESPONSE_INVALID"
  | "HISTORY_IPC_RESPONSE_INVALID"
  | "SETTINGS_IPC_RESPONSE_INVALID"
  | "TRANSCRIPT_IPC_RESPONSE_INVALID"
  | "UPDATE_IPC_RESPONSE_INVALID";

export class IpcProtocolError extends Error {
  readonly code: IpcProtocolErrorCode;

  constructor(code: IpcProtocolErrorCode) {
    super(code);
    this.name = "IpcProtocolError";
    this.code = code;
  }
}

export function readIpcDataObject(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  errorCode: IpcProtocolErrorCode,
): Record<string, unknown> {
  try {
    return readDataObjectUnchecked(
      value,
      requiredKeys,
      optionalKeys,
      errorCode,
    );
  } catch {
    throw new IpcProtocolError(errorCode);
  }
}

export function readIpcDataArray(
  value: unknown,
  errorCode: IpcProtocolErrorCode,
): unknown[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      throw new IpcProtocolError(errorCode);
    }

    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      !lengthDescriptor ||
      !("value" in lengthDescriptor) ||
      typeof lengthDescriptor.value !== "number" ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0
    ) {
      throw new IpcProtocolError(errorCode);
    }

    const actualKeys = Reflect.ownKeys(value);
    if (
      !actualKeys.every((key): key is string => typeof key === "string") ||
      actualKeys.length !== lengthDescriptor.value + 1 ||
      actualKeys[actualKeys.length - 1] !== "length"
    ) {
      throw new IpcProtocolError(errorCode);
    }

    const items: unknown[] = [];
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const key = String(index);
      if (actualKeys[index] !== key) {
        throw new IpcProtocolError(errorCode);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        throw new IpcProtocolError(errorCode);
      }
      items.push(descriptor.value);
    }
    return items;
  } catch {
    throw new IpcProtocolError(errorCode);
  }
}

function readDataObjectUnchecked(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  errorCode: IpcProtocolErrorCode,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new IpcProtocolError(errorCode);
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new IpcProtocolError(errorCode);
  }

  const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);
  if (allowedKeys.size !== requiredKeys.length + optionalKeys.length) {
    throw new IpcProtocolError(errorCode);
  }

  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.some((key) => typeof key !== "string") ||
    ownKeys.some((key) => !allowedKeys.has(key as string)) ||
    requiredKeys.some((key) => !ownKeys.includes(key))
  ) {
    throw new IpcProtocolError(errorCode);
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const entries = ownKeys.map((key) => {
    const descriptor = descriptors[key as string];
    if (!descriptor || !("value" in descriptor)) {
      throw new IpcProtocolError(errorCode);
    }
    return [key as string, descriptor.value] as const;
  });

  return Object.fromEntries(entries);
}
