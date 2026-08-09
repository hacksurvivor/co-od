import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface ProjectMemoryFile {
  path: string;
  title: string;
  bytes: number;
}

export interface ProjectMemory {
  files: ProjectMemoryFile[];
  error?: string;
}

const DIRECT_MEMORY_FILES = [
  "MEMORY.md",
  "PROJECT_MEMORY.md",
  "CONTEXT.md",
  ".co-od/memory.md",
  ".co-od/memories.md",
  ".co-od/context.md",
  ".claude/memory.md",
  ".claude/memories.md",
  ".agents/memory.md",
  ".agents/context.md",
];

const MEMORY_DIRECTORIES = [
  ".co-od/memories",
  ".co-od/context",
  ".agents/memories",
  ".agents/context",
  "memory",
  "memories",
];

export function loadProjectMemory(dir: string): ProjectMemory {
  try {
    const files: ProjectMemoryFile[] = [];
    for (const path of DIRECT_MEMORY_FILES) {
      addMemoryFile(files, dir, path);
    }

    for (const directory of MEMORY_DIRECTORIES) {
      addMemoryDirectory(files, dir, directory);
    }

    return { files: dedupeMemoryFiles(files) };
  } catch (error) {
    return {
      files: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function memorySummary(memory: ProjectMemory, limit = 6): string[] {
  if (memory.error) return [`memory unavailable: ${memory.error}`];
  if (memory.files.length === 0) return ["No project memory files found."];
  const lines = memory.files
    .slice(0, limit)
    .map((file) => `${file.path} ${file.title ? `- ${file.title}` : ""}`.trim());
  if (memory.files.length > limit) {
    lines.push(`... ${memory.files.length - limit} more`);
  }
  return lines;
}

function addMemoryDirectory(files: ProjectMemoryFile[], dir: string, directory: string): void {
  const absoluteDirectory = join(dir, directory);
  if (!existsSync(absoluteDirectory)) return;
  const stat = statSync(absoluteDirectory);
  if (!stat.isDirectory()) return;
  for (const entry of readdirSync(absoluteDirectory).sort()) {
    if (!entry.endsWith(".md")) continue;
    addMemoryFile(files, dir, `${directory}/${entry}`);
  }
}

function addMemoryFile(files: ProjectMemoryFile[], dir: string, path: string): void {
  const absolutePath = join(dir, path);
  if (!existsSync(absolutePath)) return;
  const stat = statSync(absolutePath);
  if (!stat.isFile()) return;
  files.push({
    path,
    title: readMemoryTitle(absolutePath),
    bytes: stat.size,
  });
}

function readMemoryTitle(path: string): string {
  try {
    const text = readFileSync(path, "utf-8").slice(0, 4096);
    const heading = text.split(/\r?\n/).find((line) => /^#{1,3}\s+/.test(line));
    return heading ? heading.replace(/^#{1,3}\s+/, "").trim() : "";
  } catch {
    return "";
  }
}

function dedupeMemoryFiles(files: ProjectMemoryFile[]): ProjectMemoryFile[] {
  const seen = new Set<string>();
  const result: ProjectMemoryFile[] = [];
  for (const file of files) {
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    result.push(file);
  }
  return result;
}
