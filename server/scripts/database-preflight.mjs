import { accessSync, constants, existsSync, openSync, closeSync, readSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const REQUIRED_TABLES = ["ActivationCode", "AdminEntitlementAdjustment", "AdminSession", "AuthRateLimit", "DesktopLoginTicket", "EmailOtp", "Entitlement", "LlmConfig", "LlmUsageEvent", "Order", "Session", "User", "UserSession", "WebhookEvent"].sort();

try {
  const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const databasePath = localDatabasePath(process.env.DATABASE_URL, serverRoot);
  accessSync(dirname(databasePath), constants.R_OK | constants.W_OK);
  if (!existsSync(databasePath) || !statSync(databasePath).isFile()) fail();
  verifyHeader(databasePath);
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const integrity = database.prepare("PRAGMA integrity_check").get();
    if (integrity?.integrity_check !== "ok") fail();
    if (database.prepare("PRAGMA foreign_key_check").all().length !== 0) fail();
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_prisma_migrations' ORDER BY name").all().map(({ name }) => name);
    if (tables.join("\0") !== REQUIRED_TABLES.join("\0")) fail();
    const migration = database.prepare("SELECT COUNT(*) AS count FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL").get();
    if (Number(migration?.count) < 1) fail();
  } finally { database.close(); }
  process.stdout.write("StudyMind database preflight passed.\n");
} catch {
  process.stderr.write("StudyMind database preflight failed.\n");
  process.exitCode = 1;
}

function localDatabasePath(source, root) {
  if (typeof source !== "string" || !source.startsWith("file:") || source.includes("?") || source.includes("#")) fail();
  const raw = source.slice(5);
  if (!raw || raw.startsWith("//") || /^\/(?:mnt|net|nfs|Volumes)\//i.test(raw)) fail();
  const value = decodeURIComponent(raw);
  if (/^\\\\/.test(value)) fail();
  return isAbsolute(value) || /^[A-Za-z]:\\/.test(value) ? resolve(value) : resolve(root, value);
}
function verifyHeader(path) {
  const size = statSync(path).size;
  if (size === 0) return;
  if (size < 16) fail();
  const descriptor = openSync(path, "r"); const header = Buffer.alloc(16);
  try { readSync(descriptor, header, 0, 16, 0); } finally { closeSync(descriptor); }
  if (!header.equals(Buffer.from("SQLite format 3\0"))) fail();
}
function fail() { throw new Error("PREFLIGHT_FAILED"); }
