import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface ProjectInstructionFile {
  path: string;
  title: string;
  bytes: number;
}

export interface ProjectInstructions {
  files: ProjectInstructionFile[];
  error?: string;
}

const DIRECT_INSTRUCTION_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "CONTRIBUTING.md",
  ".cursorrules",
  ".cursor/rules",
  ".github/copilot-instructions.md",
  "README.md",
];

export function loadProjectInstructions(dir: string): ProjectInstructions {
  try {
    const files: ProjectInstructionFile[] = [];
    for (const path of DIRECT_INSTRUCTION_FILES) {
      addInstructionFile(files, dir, path);
    }

    const agentsDir = join(dir, ".agents");
    if (existsSync(agentsDir)) {
      for (const entry of readdirSync(agentsDir)) {
        if (entry.endsWith(".md")) {
          addInstructionFile(files, dir, `.agents/${entry}`);
        }
      }
    }

    return { files: dedupeInstructionFiles(files) };
  } catch (error) {
    return {
      files: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function instructionSummary(instructions: ProjectInstructions, limit = 6): string[] {
  if (instructions.error) return [`instructions unavailable: ${instructions.error}`];
  if (instructions.files.length === 0) return ["No project instruction files found."];
  const lines = instructions.files
    .slice(0, limit)
    .map((file) => `${file.path} ${file.title ? `- ${file.title}` : ""}`.trim());
  if (instructions.files.length > limit) {
    lines.push(`... ${instructions.files.length - limit} more`);
  }
  return lines;
}

function addInstructionFile(files: ProjectInstructionFile[], dir: string, path: string): void {
  const absolutePath = join(dir, path);
  if (!existsSync(absolutePath)) return;
  const stat = statSync(absolutePath);
  if (!stat.isFile()) return;
  files.push({
    path,
    title: readInstructionTitle(absolutePath),
    bytes: stat.size,
  });
}

function readInstructionTitle(path: string): string {
  try {
    const text = readFileSync(path, "utf-8").slice(0, 4096);
    const heading = text.split(/\r?\n/).find((line) => /^#{1,3}\s+/.test(line));
    return heading ? heading.replace(/^#{1,3}\s+/, "").trim() : "";
  } catch {
    return "";
  }
}

function dedupeInstructionFiles(files: ProjectInstructionFile[]): ProjectInstructionFile[] {
  const seen = new Set<string>();
  const result: ProjectInstructionFile[] = [];
  for (const file of files) {
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    result.push(file);
  }
  return result;
}
