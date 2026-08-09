import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface WorkspaceFileChange {
  status: string;
  path: string;
}

export interface WorkspaceContext {
  isGitRepo: boolean;
  root?: string;
  branch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  dirty: boolean;
  changedFiles: WorkspaceFileChange[];
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  insertions: number;
  deletions: number;
  error?: string;
}

export interface WorkspaceFileList {
  files: string[];
  query?: string;
  error?: string;
}

export interface WorkspaceSearchMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

export interface WorkspaceSearchResult {
  query: string;
  matches: WorkspaceSearchMatch[];
  error?: string;
}

export interface WorkspaceDiffResult {
  path?: string;
  lines: string[];
  truncated: boolean;
  error?: string;
}

export interface WorkspaceFilePreviewLine {
  number: number;
  text: string;
  selected: boolean;
}

export interface WorkspaceFilePreviewResult {
  path: string;
  requestedLine?: number;
  startLine: number;
  endLine: number;
  totalLines: number;
  lines: WorkspaceFilePreviewLine[];
  truncated: boolean;
  error?: string;
}

export type WorkspaceCommandRunner = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

const EMPTY_WORKSPACE: WorkspaceContext = {
  isGitRepo: false,
  ahead: 0,
  behind: 0,
  dirty: false,
  changedFiles: [],
  stagedCount: 0,
  unstagedCount: 0,
  untrackedCount: 0,
  insertions: 0,
  deletions: 0,
};

function runCommand(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 2_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        if (file === "rg" && String((error as NodeJS.ErrnoException).code) === "1") {
          resolve({ stdout, stderr });
          return;
        }
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export function parseGitBranchLine(line: string): Pick<WorkspaceContext, "branch" | "upstream" | "ahead" | "behind"> {
  const body = line.replace(/^##\s*/, "").trim();
  const [branchPart, metaPart = ""] = body.split(" [");
  const [branch = "", upstream] = branchPart.split("...");
  const ahead = Number(metaPart.match(/ahead (\d+)/)?.[1] || 0);
  const behind = Number(metaPart.match(/behind (\d+)/)?.[1] || 0);
  return {
    branch: branch || undefined,
    upstream,
    ahead,
    behind,
  };
}

export function parseGitStatusShort(statusText: string): Pick<
  WorkspaceContext,
  "branch" | "upstream" | "ahead" | "behind" | "dirty" | "changedFiles" | "stagedCount" | "unstagedCount" | "untrackedCount"
> {
  const lines = statusText.split(/\r?\n/).filter(Boolean);
  const branchLine = lines.find((line) => line.startsWith("## "));
  const branch = branchLine ? parseGitBranchLine(branchLine) : { ahead: 0, behind: 0 };
  const changedFiles = lines
    .filter((line) => !line.startsWith("## "))
    .map((line) => ({
      status: line.slice(0, 2),
      path: line.slice(3).trim(),
    }));

  const stagedCount = changedFiles.filter((file) => file.status[0] !== " " && file.status[0] !== "?").length;
  const unstagedCount = changedFiles.filter((file) => file.status[1] !== " " && file.status[1] !== "?").length;
  const untrackedCount = changedFiles.filter((file) => file.status === "??").length;

  return {
    branch: branch.branch,
    upstream: branch.upstream,
    ahead: branch.ahead,
    behind: branch.behind,
    dirty: changedFiles.length > 0,
    changedFiles,
    stagedCount,
    unstagedCount,
    untrackedCount,
  };
}

export function parseGitNumstat(numstatText: string): Pick<WorkspaceContext, "insertions" | "deletions"> {
  let insertions = 0;
  let deletions = 0;
  for (const line of numstatText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [added, removed] = line.split(/\s+/);
    if (/^\d+$/.test(added)) insertions += Number(added);
    if (/^\d+$/.test(removed)) deletions += Number(removed);
  }
  return { insertions, deletions };
}

export function filterWorkspaceFiles(files: string[], query = "", limit = 40): string[] {
  const normalized = query.trim().toLowerCase();
  const candidates = normalized
    ? files.filter((file) => file.toLowerCase().includes(normalized))
    : files;
  return candidates.slice(0, limit);
}

export function parseRipgrepSearchOutput(output: string): WorkspaceSearchMatch[] {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(.+?):(\d+):(\d+):(.*)$/);
      if (!match) return null;
      return {
        path: match[1],
        line: Number(match[2]),
        column: Number(match[3]),
        text: match[4],
      };
    })
    .filter((match): match is WorkspaceSearchMatch => Boolean(match));
}

export function workspaceRelativePath(dir: string, path: string): string {
  if (!path.startsWith("/")) return path;
  const relativePath = relative(dir, path);
  return relativePath && !relativePath.startsWith("..") ? relativePath : path;
}

export function parseWorkspaceFilePreviewRef(value: string): { path: string; line?: number } {
  const trimmed = stripWrappingQuotes(value.trim());
  const match = trimmed.match(/^(.+?):(\d+)(?::\d+)?$/);
  if (!match) return { path: trimmed };
  return {
    path: match[1],
    line: Math.max(1, Number(match[2]) || 1),
  };
}

export function loadWorkspaceFilePreview(input: {
  dir: string;
  ref: string;
  contextLines?: number;
  maxBytes?: number;
  maxLineLength?: number;
}): WorkspaceFilePreviewResult {
  const parsed = parseWorkspaceFilePreviewRef(input.ref);
  const requestedPath = parsed.path;
  if (!requestedPath) {
    return emptyFilePreview("", "Usage: /view <path[:line]>");
  }

  const root = resolve(input.dir);
  const absolutePath = isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(root, requestedPath);
  if (!isPathInside(root, absolutePath)) {
    return emptyFilePreview(requestedPath, "File preview is limited to the current workspace.");
  }
  if (!existsSync(absolutePath)) {
    return emptyFilePreview(requestedPath, `File not found: ${requestedPath}`);
  }

  const stat = statSync(absolutePath);
  if (!stat.isFile()) {
    return emptyFilePreview(requestedPath, `Not a file: ${requestedPath}`);
  }

  const maxBytes = Math.max(1, input.maxBytes || 180_000);
  if (stat.size > maxBytes) {
    return emptyFilePreview(requestedPath, `File is too large to preview (${stat.size} bytes, limit ${maxBytes}).`);
  }

  const buffer = readFileSync(absolutePath);
  if (buffer.includes(0)) {
    return emptyFilePreview(requestedPath, `Binary file preview is not supported: ${requestedPath}`);
  }

  const text = buffer.toString("utf8");
  const allLines = text.split(/\r?\n/);
  if (allLines.at(-1) === "") allLines.pop();

  const totalLines = Math.max(1, allLines.length);
  const requestedLine = Math.min(Math.max(1, parsed.line || 1), totalLines);
  const contextLines = Math.max(0, input.contextLines ?? 8);
  const startLine = Math.max(1, requestedLine - contextLines);
  const endLine = Math.min(totalLines, requestedLine + contextLines);
  const maxLineLength = Math.max(20, input.maxLineLength || 220);

  return {
    path: workspaceRelativePath(root, absolutePath),
    requestedLine,
    startLine,
    endLine,
    totalLines,
    lines: allLines.slice(startLine - 1, endLine).map((line, index) => {
      const number = startLine + index;
      return {
        number,
        selected: number === requestedLine,
        text: truncatePreviewLine(line, maxLineLength),
      };
    }),
    truncated: startLine > 1 || endLine < totalLines,
  };
}

export function formatWorkspaceFilePreview(result: WorkspaceFilePreviewResult): string {
  if (result.error) return result.error;
  const width = String(result.endLine).length;
  return [
    `File ${result.path}:${result.startLine}-${result.endLine} (${result.totalLines} lines)`,
    ...result.lines.map((line) => {
      const marker = line.selected ? ">" : " ";
      return `${marker} ${String(line.number).padStart(width)} | ${line.text}`;
    }),
    result.truncated ? "Use /view <path:line> to move the preview window." : "",
  ].filter(Boolean).join("\n");
}

export async function loadWorkspaceContext(
  dir: string,
  commandRunner: WorkspaceCommandRunner = runCommand,
): Promise<WorkspaceContext> {
  try {
    const rootResult = await commandRunner("git", ["-C", dir, "rev-parse", "--show-toplevel"]);
    const [statusResult, numstatResult] = await Promise.all([
      commandRunner("git", ["-C", dir, "status", "--short", "--branch"]),
      commandRunner("git", ["-C", dir, "diff", "--numstat", "HEAD"]).catch(() => ({ stdout: "", stderr: "" })),
    ]);
    const status = parseGitStatusShort(statusResult.stdout);
    const numstat = parseGitNumstat(numstatResult.stdout);
    return {
      ...EMPTY_WORKSPACE,
      isGitRepo: true,
      root: rootResult.stdout.trim(),
      ...status,
      ...numstat,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...EMPTY_WORKSPACE,
      error: message,
    };
  }
}

export async function listWorkspaceFiles(input: {
  dir: string;
  query?: string;
  limit?: number;
  commandRunner?: WorkspaceCommandRunner;
}): Promise<WorkspaceFileList> {
  const commandRunner = input.commandRunner || runCommand;
  try {
    const result = await commandRunner("rg", ["--files", "--hidden", "-g", "!.git", input.dir]);
    const files = result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((file) => workspaceRelativePath(input.dir, file));
    return {
      query: input.query,
      files: filterWorkspaceFiles(files, input.query, input.limit || 40),
    };
  } catch (error) {
    return {
      query: input.query,
      files: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function searchWorkspaceText(input: {
  dir: string;
  query: string;
  limit?: number;
  commandRunner?: WorkspaceCommandRunner;
}): Promise<WorkspaceSearchResult> {
  const query = input.query.trim();
  if (!query) {
    return { query, matches: [], error: "Search needs a query." };
  }

  const commandRunner = input.commandRunner || runCommand;
  try {
    const result = await commandRunner("rg", [
      "--line-number",
      "--column",
      "--no-heading",
      "--color",
      "never",
      "--smart-case",
      query,
      input.dir,
    ]);
    return {
      query,
      matches: parseRipgrepSearchOutput(result.stdout)
        .map((match) => ({ ...match, path: workspaceRelativePath(input.dir, match.path) }))
        .slice(0, input.limit || 40),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      query,
      matches: [],
      error: message,
    };
  }
}

export async function loadWorkspaceDiff(input: {
  dir: string;
  path?: string;
  limit?: number;
  commandRunner?: WorkspaceCommandRunner;
}): Promise<WorkspaceDiffResult> {
  const path = input.path?.trim();
  const limit = input.limit || 240;
  const commandRunner = input.commandRunner || runCommand;
  try {
    const args = ["-C", input.dir, "diff", "--no-ext-diff", "--color=never", "HEAD", "--"];
    if (path) args.push(path);
    const result = await commandRunner("git", args);
    const allLines = result.stdout.split(/\r?\n/);
    if (allLines.at(-1) === "") allLines.pop();
    return {
      path,
      lines: allLines.slice(0, limit),
      truncated: allLines.length > limit,
    };
  } catch (error) {
    return {
      path,
      lines: [],
      truncated: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function emptyFilePreview(path: string, error: string): WorkspaceFilePreviewResult {
  return {
    path,
    startLine: 0,
    endLine: 0,
    totalLines: 0,
    lines: [],
    truncated: false,
    error,
  };
}

function isPathInside(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function stripWrappingQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function truncatePreviewLine(line: string, maxLength: number): string {
  if (line.length <= maxLength) return line;
  return `${line.slice(0, Math.max(0, maxLength - 3))}...`;
}
