import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function defaultIntelligenceDbPath(): string {
  return fileURLToPath(new URL("../.data/zora-intelligence.db", import.meta.url));
}

export function resolveVitestSafeDbPath(dbPath: string, label: string): string {
  if (dbPath === ":memory:") return dbPath;

  const resolvedPath = path.resolve(dbPath);
  const tmpRoot = path.resolve(os.tmpdir());
  if (resolvedPath === tmpRoot || resolvedPath.startsWith(`${tmpRoot}${path.sep}`)) {
    return resolvedPath;
  }

  throw new Error(
    `DB safety violation: Vitest is active but ${label} points outside os.tmpdir(): ${resolvedPath}`,
  );
}
