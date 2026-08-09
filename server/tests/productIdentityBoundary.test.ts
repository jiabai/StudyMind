import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(serverRoot, "..");

const forbidden = [
  new RegExp(["Frame", "Q"].join(""), "g"),
  new RegExp(["frameq", ":\\/\\/"].join(""), "g"),
  new RegExp(["FRAMEQ", "_"].join(""), "g"),
  new RegExp(["frameq_", "(?:user|admin)"].join(""), "g"),
  new RegExp(["x-frameq", "-csrf"].join(""), "g"),
  new RegExp(`\\b(?:${[
    ["fl", "t_"].join(""),
    ["f", "q_"].join(""),
    ["fq", "us_"].join(""),
    ["fq", "cs_"].join(""),
    ["fa", "s_"].join(""),
    ["fa", "c_"].join(""),
    ["fu", "s_"].join(""),
    ["fu", "c_"].join(""),
  ].join("|")})`, "g"),
];

type SourceFile = { path: string; content: string };

function collectFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) {
    return [path];
  }

  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    collectFiles(resolve(path, entry.name)),
  );
}

function findIdentityResidues(files: SourceFile[]): string[] {
  return files.flatMap(({ path, content }) =>
    forbidden.flatMap((pattern) => {
      pattern.lastIndex = 0;
      return [...content.matchAll(pattern)].map((match) => {
        const line = content.slice(0, match.index).split(/\r?\n/).length;
        return `${path}:${line}:${match[0]}`;
      });
    }),
  );
}

const scannedPaths = [
  resolve(serverRoot, "src"),
  resolve(serverRoot, "tests"),
  resolve(serverRoot, "scripts"),
  resolve(serverRoot, "prisma"),
  resolve(serverRoot, ".env.example"),
  resolve(repositoryRoot, "app/src-tauri/src/account.rs"),
  resolve(repositoryRoot, "app/src-tauri/src/lib.rs"),
];

describe("StudyMind product identity boundary", () => {
  test("scanner detects a forbidden in-memory fixture", () => {
    const legacyName = ["Frame", "Q"].join("");
    expect(findIdentityResidues([{ path: "fixture.ts", content: legacyName }])).toEqual([
      `fixture.ts:1:${legacyName}`,
    ]);
  });

  test("server and account runtime contain only StudyMind identities", () => {
    const files = scannedPaths.flatMap(collectFiles).map((path) => ({
      path: relative(repositoryRoot, path).replaceAll("\\", "/"),
      content: readFileSync(path, "utf8"),
    }));

    expect(findIdentityResidues(files)).toEqual([]);
  });
});
