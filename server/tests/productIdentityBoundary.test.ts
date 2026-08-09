import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, test } from "vitest";

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(serverRoot, "..");

const decodePattern = (encoded: string) => Buffer.from(encoded, "base64").toString("utf8");
const forbidden = [
  "RnJhbWVR",
  "ZnJhbWVxOlwvXC8=",
  "RlJBTUVRXw==",
  "ZnJhbWVxXyg/OnVzZXJ8YWRtaW4p",
  "eC1mcmFtZXEtY3NyZg==",
  "XGIoPzpmbHRffGZxX3xmcXVzX3xmcWNzX3xmYXNffGZhY198ZnVzX3xmdWNfKQ==",
].map((encoded) => new RegExp(decodePattern(encoded), "g"));

type SourceFile = { path: string; content: string };
type ScanText = { content: string; indexOffset: number; raw?: boolean };

function collectFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) {
    return [path];
  }

  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    collectFiles(resolve(path, entry.name)),
  );
}

function findIdentityResidues(files: SourceFile[]): string[] {
  return files.flatMap(({ path, content }) => {
    const scanTexts: ScanText[] = [{ content, indexOffset: 0, raw: true }, ...foldStaticStrings(path, content)];
    const findings = scanTexts.flatMap((scanText) => forbidden.flatMap((pattern) => {
      pattern.lastIndex = 0;
      return [...scanText.content.matchAll(pattern)].map((match) => {
        const sourceIndex = scanText.raw ? match.index : scanText.indexOffset;
        const line = content.slice(0, sourceIndex).split(/\r?\n/).length;
        return `${path}:${line}:${match[0]}`;
      });
    }));
    return [...new Set(findings)];
  });
}

function foldStaticStrings(path: string, content: string): ScanText[] {
  if (/\.(?:[cm]?[jt]s|tsx)$/i.test(path)) return foldTypeScriptStrings(path, content);
  if (/\.rs$/i.test(path)) return foldRustConcatStrings(content);
  return [];
}

function foldTypeScriptStrings(path: string, content: string): ScanText[] {
  const kind = path.endsWith("x") ? ts.ScriptKind.TSX : path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, kind);
  const folded: ScanText[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isExpression(node)) {
      const value = evaluateTypeScriptString(node);
      if (value !== null && !ts.isStringLiteralLike(node)) folded.push({ content: value, indexOffset: node.getStart(source) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return folded;
}

function evaluateTypeScriptString(node: ts.Expression): string | null {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return evaluateTypeScriptString(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = evaluateTypeScriptString(node.left);
    const right = evaluateTypeScriptString(node.right);
    return left === null || right === null ? null : left + right;
  }
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return null;
  const receiver = node.expression.expression;
  const method = node.expression.name.text;
  if (method === "join" && ts.isArrayLiteralExpression(receiver) && node.arguments.length <= 1) {
    const separator = node.arguments.length === 0 ? "," : evaluateTypeScriptString(node.arguments[0]!);
    const values = receiver.elements.map((element) => ts.isExpression(element) ? evaluateTypeScriptString(element) : null);
    return separator === null || values.some((value) => value === null) ? null : (values as string[]).join(separator);
  }
  if (method === "concat") {
    const base = evaluateTypeScriptString(receiver);
    const values = node.arguments.map(evaluateTypeScriptString);
    return base === null || values.some((value) => value === null) ? null : base + (values as string[]).join("");
  }
  return null;
}

function foldRustConcatStrings(content: string): ScanText[] {
  return [...content.matchAll(/\bconcat!\s*\(([\s\S]*?)\)/g)].flatMap((match) => {
    const value = parseRustStringArguments(match[1] ?? "");
    return value === null ? [] : [{ content: value, indexOffset: match.index }];
  });
}

function parseRustStringArguments(body: string): string | null {
  const values: string[] = [];
  let rest = body;
  while (rest.trim()) {
    const match = /^\s*("(?:\\.|[^"\\])*")\s*(?:,\s*|$)/.exec(rest);
    if (!match) return null;
    try { values.push(JSON.parse(match[1]!)); }
    catch { return null; }
    rest = rest.slice(match[0].length);
  }
  return values.join("");
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
    const legacyName = decodePattern("RnJhbWVR");
    expect(findIdentityResidues([{ path: "fixture.ts", content: ["safe", legacyName].join("\n") }])).toEqual([
      `fixture.ts:2:${legacyName}`,
    ]);
  });

  test("scanner detects statically joined TypeScript and Rust identities", () => {
    const typescriptFixture = Buffer.from(
      "Y29uc3QgYT0iRnJhbWUiKyJRIjtjb25zdCBiPVsiZnJhbWVxIiwiOi8vIl0uam9pbigiIik7Y29uc3QgYz0iRlJBTUVRIi5jb25jYXQoIl9TRUNSRVQiKTtjb25zdCBkPVsiZnJhbWVxXyIsInVzZXIiXS5qb2luKCIiKTtjb25zdCBlPVsieC1mcmFtZXEiLCItY3NyZiJdLmpvaW4oIiIpO2NvbnN0IHQxPVsiZmwiLCJ0X2xlZ2FjeSJdLmpvaW4oIiIpO2NvbnN0IHQyPVsiZiIsInFfdG9rZW4iXS5qb2luKCIiKTtjb25zdCB0Mz1bImZxIiwidXNfdG9rZW4iXS5qb2luKCIiKTtjb25zdCB0ND1bImZxIiwiY3NfdG9rZW4iXS5qb2luKCIiKTtjb25zdCB0NT1bImZhIiwic190b2tlbiJdLmpvaW4oIiIpO2NvbnN0IHQ2PVsiZmEiLCJjX3Rva2VuIl0uam9pbigiIik7Y29uc3QgdDc9WyJmdSIsInNfdG9rZW4iXS5qb2luKCIiKTtjb25zdCB0OD1bImZ1IiwiY190b2tlbiJdLmpvaW4oIiIpOw==",
      "base64",
    ).toString("utf8");
    const rustFixture = Buffer.from(
      "Y29uc3QgYSA9IGNvbmNhdCEoIkZyYW1lIiwgIlEiKTsgbGV0IGIgPSBjb25jYXQhKCJmbCIsICJ0X2xlZ2FjeSIpOw==",
      "base64",
    ).toString("utf8");

    const findings = findIdentityResidues([
      { path: "fixture.ts", content: typescriptFixture },
      { path: "fixture.rs", content: rustFixture },
    ]);
    const expectedTypeScriptTokens = [
      "RnJhbWVR", "ZnJhbWVxOi8v", "RlJBTUVRXw==", "ZnJhbWVxX3VzZXI=", "eC1mcmFtZXEtY3NyZg==",
      "Zmx0Xw==", "ZnFf", "ZnF1c18=", "ZnFjc18=", "ZmFzXw==", "ZmFjXw==", "ZnVzXw==", "ZnVjXw==",
    ].map(decodePattern);
    const expectedRustTokens = ["RnJhbWVR", "Zmx0Xw=="].map(decodePattern);
    for (const token of expectedTypeScriptTokens) expect(findings).toContain(`fixture.ts:1:${token}`);
    for (const token of expectedRustTokens) expect(findings).toContain(`fixture.rs:1:${token}`);
  });

  test("server and account runtime contain only StudyMind identities", () => {
    const files = scannedPaths.flatMap(collectFiles).map((path) => ({
      path: relative(repositoryRoot, path).replaceAll("\\", "/"),
      content: readFileSync(path, "utf8"),
    }));

    expect(findIdentityResidues(files)).toEqual([]);
  });
});
