import { readFile, stat } from "node:fs/promises";
import { resolveInsideWorkspace } from "./pathSafety.js";

export interface FileContentResponse {
  path: string;
  language?: string;
  encoding: "utf8";
  size: number;
  modifiedAt: string;
  content: string;
  truncated: boolean;
  binary: boolean;
}

const MAX_BYTES = 512 * 1024;

export async function readWorkspaceFile(rootPath: string, path: string | undefined): Promise<FileContentResponse> {
  if (path === undefined || path === "") throw new Error("path query parameter is required");
  const { target, relativePath } = await resolveInsideWorkspace(rootPath, path);
  const s = await stat(target);
  if (!s.isFile()) throw new Error("Path is not a file");
  const bytesToRead = Math.min(s.size, MAX_BYTES);
  const buffer = (await readFile(target)).subarray(0, bytesToRead);
  const binary = isProbablyBinary(buffer);
  return {
    path: relativePath,
    ...languageForPath(relativePath),
    encoding: "utf8",
    size: s.size,
    modifiedAt: s.mtime.toISOString(),
    content: binary ? "" : buffer.toString("utf8"),
    truncated: s.size > MAX_BYTES,
    binary,
  };
}

function isProbablyBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  return sample.includes(0);
}

function languageForPath(path: string): { language?: string } {
  const ext = path.split(".").pop()?.toLowerCase();
  const languages: Record<string, string | undefined> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    json: "json",
    md: "markdown",
    css: "css",
    html: "html",
    py: "python",
    rs: "rust",
    go: "go",
    sh: "shell",
    yml: "yaml",
    yaml: "yaml",
  };
  const language = ext === undefined ? undefined : languages[ext];
  return language === undefined ? {} : { language };
}
