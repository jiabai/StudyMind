import { copyFileSync, existsSync, mkdtempSync, openSync, closeSync, readSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const REQUIRED_TABLES = ["ActivationCode", "AdminEntitlementAdjustment", "AdminSession", "AuthRateLimit", "DesktopLoginTicket", "EmailOtp", "Entitlement", "LlmConfig", "LlmUsageEvent", "Order", "Session", "User", "UserSession", "WebhookEvent"].sort();
let temporaryDirectory;
try {
  const backupArgument = process.argv[2] === "--backup" ? process.argv[3] : process.argv[2];
  const backup = validateBackup(backupArgument);
  temporaryDirectory = mkdtempSync(join(tmpdir(), "studymind-restore-smoke-"));
  const restored = join(temporaryDirectory, "restored.sqlite");
  copyFileSync(backup, restored);
  const database = new DatabaseSync(restored, { readOnly: true });
  try {
    if (database.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") fail();
    if (database.prepare("PRAGMA foreign_key_check").all().length !== 0) fail();
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_prisma_migrations' ORDER BY name").all().map(({ name }) => name);
    if (tables.join("\0") !== REQUIRED_TABLES.join("\0")) fail();
  } finally { database.close(); }
  process.stdout.write("StudyMind restore smoke test passed.\n");
} catch {
  process.stderr.write("StudyMind restore smoke test failed.\n");
  process.exitCode = 1;
} finally {
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true, maxRetries: 3 });
}

function validateBackup(value) {
  if (typeof value !== "string" || !isAbsolute(value) || /^\\\\/.test(value) || /^\/(?:mnt|net|nfs|Volumes)\//i.test(value)) fail();
  const path = resolve(value);
  if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size < 16) fail();
  const descriptor = openSync(path, "r"); const header = Buffer.alloc(16);
  try { readSync(descriptor, header, 0, 16, 0); } finally { closeSync(descriptor); }
  if (!header.equals(Buffer.from("SQLite format 3\0"))) fail();
  return path;
}
function fail() { throw new Error("RESTORE_SMOKE_FAILED"); }
