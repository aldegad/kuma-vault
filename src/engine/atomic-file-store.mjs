import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function writeFileAtomic(filePath, content, options = "utf8") {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;

  try {
    await writeFile(tempPath, content, options);
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

export function writeFileAtomicSync(filePath, content, options = "utf8") {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;

  try {
    writeFileSync(tempPath, content, options);
    renameSync(tempPath, filePath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

export function readJsonFileOrDefaultSync(filePath, defaultFactory) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return typeof defaultFactory === "function" ? defaultFactory() : defaultFactory;
    }
    throw new Error(`Failed to read JSON store ${filePath}: ${describeError(error)}`, { cause: error });
  }
}
