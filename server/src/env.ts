export type Environment = "development" | "test" | "production";

export function parseEnvironment(value: string | undefined): Environment {
  if (value === undefined || value === "") return "development";
  if (value === "development" || value === "test" || value === "production") return value;
  throw new Error("NODE_ENV must be development, test, or production.");
}

export function parseBoolean(name: string, value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === "") return fallback;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`${name} must be true or false.`);
}

export function parseInteger(name: string, value: string | undefined, fallback: number, range: { min: number; max: number }): number {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer.`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < range.min || result > range.max) throw new Error(`${name} is outside the allowed range.`);
  return result;
}

export function optionalText(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function requireUtf8Secret(name: string, value: string | undefined, production: boolean, developmentFallback: string): string {
  const result = value ?? (production ? "" : developmentFallback);
  if (Buffer.byteLength(result, "utf8") < 32) throw new Error(`${name} must contain at least 32 UTF-8 bytes.`);
  return result;
}
