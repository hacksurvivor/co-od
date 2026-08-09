import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { workspaceRelativePath, type WorkspaceCommandRunner } from "./tui-workspace.js";

export type DiagnosticsKind = "typescript" | "python" | "go" | "rust" | "all";

export interface TypeScriptDiagnostic {
  file: string;
  line: number;
  column: number;
  code: string;
  severity: "error" | "warning";
  message: string;
  language?: DiagnosticsKind;
}

export interface TypeScriptDiagnosticResult {
  kind?: DiagnosticsKind;
  label?: string;
  project?: string;
  diagnostics: TypeScriptDiagnostic[];
  projects?: string[];
  error?: string;
  results?: TypeScriptDiagnosticResult[];
}

export type DiagnosticCommandRunner = (
  file: string,
  args: string[],
  options?: { cwd?: string; timeoutMs?: number },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

function runDiagnosticCommand(
  file: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd: options.cwd, timeout: options.timeoutMs ?? 15_000, maxBuffer: 1024 * 1024 * 4 }, (error, stdout, stderr) => {
      const exitCode = typeof (error as NodeJS.ErrnoException | null)?.code === "number"
        ? Number((error as NodeJS.ErrnoException).code)
        : error ? 1 : 0;
      resolve({ stdout, stderr, exitCode });
    });
  });
}

export async function discoverTypeScriptProjects(
  dir: string,
  commandRunner?: WorkspaceCommandRunner,
): Promise<{ projects: string[]; error?: string }> {
  if (existsSync(join(dir, "tsconfig.json"))) {
    return { projects: ["tsconfig.json"] };
  }

  const runner = commandRunner || ((file, args) => runDiagnosticCommand(file, args));
  try {
    const result = await runner("rg", ["--files", "--hidden", "-g", "tsconfig.json", "-g", "!node_modules", "-g", "!.git", dir]);
    const projects = result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((path) => workspaceRelativePath(dir, path))
      .filter((path) => !path.includes("node_modules/"))
      .sort();
    return { projects };
  } catch (error) {
    return { projects: [], error: error instanceof Error ? error.message : String(error) };
  }
}

export function selectTypeScriptProject(projects: string[], requested?: string): string | null {
  const value = requested?.trim();
  if (value) {
    return projects.find((project) => project === value || project.endsWith(value)) || value;
  }
  return projects.length === 1 ? projects[0] : null;
}

export function parseTypeScriptDiagnostics(output: string, dir = ""): TypeScriptDiagnostic[] {
  const diagnostics: TypeScriptDiagnostic[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/);
    if (!match) continue;
    diagnostics.push({
      file: workspaceRelativePath(dir, match[1]),
      line: Number(match[2]),
      column: Number(match[3]),
      severity: match[4] as "error" | "warning",
      code: match[5],
      message: match[6],
      language: "typescript",
    });
  }
  return diagnostics;
}

export function parsePythonDiagnostics(output: string, dir = ""): TypeScriptDiagnostic[] {
  const diagnostics: TypeScriptDiagnostic[] = [];
  const lines = output.split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    const fileMatch = lines[index].match(/^\s*File "(.+?)", line (\d+)/);
    if (!fileMatch) continue;

    let code = "PY_ERROR";
    let message = "";
    for (let next = index + 1; next < Math.min(lines.length, index + 8); next++) {
      const errorMatch = lines[next].match(/^([A-Za-z_][A-Za-z0-9_]*(?:Error|Exception)):\s*(.*)$/);
      if (errorMatch) {
        code = errorMatch[1];
        message = errorMatch[2] || errorMatch[1];
        break;
      }
    }

    diagnostics.push({
      file: workspaceRelativePath(dir, fileMatch[1]),
      line: Number(fileMatch[2]),
      column: 1,
      severity: "error",
      code,
      message,
      language: "python",
    });
  }

  return diagnostics;
}

export function parseGoDiagnostics(output: string, dir = ""): TypeScriptDiagnostic[] {
  const diagnostics: TypeScriptDiagnostic[] = [];

  for (const line of output.split(/\r?\n/)) {
    if (!line || line.startsWith("# ")) continue;
    const match = line.match(/^(.+?\.go):(\d+):(?:(\d+):)?\s*(.*)$/);
    if (!match) continue;
    diagnostics.push({
      file: workspaceRelativePath(dir, match[1].replace(/^\.\//, "")),
      line: Number(match[2]),
      column: match[3] ? Number(match[3]) : 1,
      severity: "error",
      code: "GO",
      message: match[4] || "Go diagnostic",
      language: "go",
    });
  }

  return diagnostics;
}

export function parseRustDiagnostics(output: string, dir = ""): TypeScriptDiagnostic[] {
  const diagnostics: TypeScriptDiagnostic[] = [];

  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^(.+?\.rs):(\d+):(\d+):\s+(error|warning)(?:\[([^\]]+)])?:\s*(.*)$/);
    if (!match) continue;
    diagnostics.push({
      file: workspaceRelativePath(dir, match[1].replace(/^\.\//, "")),
      line: Number(match[2]),
      column: Number(match[3]),
      severity: match[4] as "error" | "warning",
      code: match[5] || match[4].toUpperCase(),
      message: match[6] || "Rust diagnostic",
      language: "rust",
    });
  }

  return diagnostics;
}

export async function discoverRustFiles(
  dir: string,
  commandRunner?: WorkspaceCommandRunner,
  maxFiles = 300,
): Promise<{ files: string[]; error?: string }> {
  const runner = commandRunner || ((file, args) => runDiagnosticCommand(file, args));
  try {
    const result = await runner("rg", [
      "--files",
      "--hidden",
      "-g",
      "*.rs",
      "-g",
      "!target",
      "-g",
      "!node_modules",
      "-g",
      "!.git",
      dir,
    ]);
    const files = result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((path) => workspaceRelativePath(dir, path))
      .filter((path) => !path.includes("target/") && !path.includes("node_modules/"))
      .sort()
      .slice(0, maxFiles);
    return { files };
  } catch (error) {
    return { files: [], error: error instanceof Error ? error.message : String(error) };
  }
}

export async function loadTypeScriptDiagnostics(input: {
  dir: string;
  project?: string;
  commandRunner?: DiagnosticCommandRunner;
  projectRunner?: WorkspaceCommandRunner;
  timeoutMs?: number;
}): Promise<TypeScriptDiagnosticResult> {
  const discovered = await discoverTypeScriptProjects(input.dir, input.projectRunner);
  if (discovered.error) {
    return { diagnostics: [], projects: discovered.projects, error: discovered.error };
  }

  const project = selectTypeScriptProject(discovered.projects, input.project);
  if (!project) {
    return {
      diagnostics: [],
      projects: discovered.projects,
      error: discovered.projects.length > 0
        ? "Multiple TypeScript projects found. Use /diagnostics <tsconfig-path>."
        : "No tsconfig.json files found.",
    };
  }

  const runner = input.commandRunner || runDiagnosticCommand;
  const result = await runner("pnpm", ["exec", "tsc", "-p", project, "--noEmit", "--pretty", "false"], {
    cwd: input.dir,
    timeoutMs: input.timeoutMs,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  return {
    kind: "typescript",
    label: project,
    project,
    diagnostics: parseTypeScriptDiagnostics(output, input.dir),
    projects: discovered.projects,
    error: result.exitCode > 0 && !output.trim() ? `tsc exited with ${result.exitCode}` : undefined,
  };
}

function diagnosticToolError(kind: Exclude<DiagnosticsKind, "all">, label: string, error: string): TypeScriptDiagnostic {
  return {
    file: label,
    line: 1,
    column: 1,
    severity: "error",
    code: "DIAGNOSTIC",
    message: error,
    language: kind,
  };
}

export async function discoverPythonFiles(
  dir: string,
  commandRunner?: WorkspaceCommandRunner,
  maxFiles = 300,
): Promise<{ files: string[]; error?: string }> {
  const runner = commandRunner || ((file, args) => runDiagnosticCommand(file, args));
  try {
    const result = await runner("rg", [
      "--files",
      "--hidden",
      "-g",
      "*.py",
      "-g",
      "!node_modules",
      "-g",
      "!.git",
      "-g",
      "!.venv",
      "-g",
      "!venv",
      dir,
    ]);
    const files = result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((path) => workspaceRelativePath(dir, path))
      .filter((path) => !path.includes("node_modules/") && !path.includes(".venv/") && !path.includes("venv/"))
      .sort()
      .slice(0, maxFiles);
    return { files };
  } catch (error) {
    return { files: [], error: error instanceof Error ? error.message : String(error) };
  }
}

export async function discoverGoFiles(
  dir: string,
  commandRunner?: WorkspaceCommandRunner,
  maxFiles = 300,
): Promise<{ files: string[]; error?: string }> {
  const runner = commandRunner || ((file, args) => runDiagnosticCommand(file, args));
  try {
    const result = await runner("rg", [
      "--files",
      "--hidden",
      "-g",
      "*.go",
      "-g",
      "!vendor",
      "-g",
      "!node_modules",
      "-g",
      "!.git",
      dir,
    ]);
    const files = result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((path) => workspaceRelativePath(dir, path))
      .filter((path) => !path.includes("vendor/") && !path.includes("node_modules/"))
      .sort()
      .slice(0, maxFiles);
    return { files };
  } catch (error) {
    return { files: [], error: error instanceof Error ? error.message : String(error) };
  }
}

export async function loadPythonDiagnostics(input: {
  dir: string;
  files?: string[];
  commandRunner?: DiagnosticCommandRunner;
  fileRunner?: WorkspaceCommandRunner;
  pythonCommand?: string;
  timeoutMs?: number;
  maxFiles?: number;
}): Promise<TypeScriptDiagnosticResult> {
  const discovered = input.files
    ? { files: input.files.slice(0, input.maxFiles || 300), error: undefined }
    : await discoverPythonFiles(input.dir, input.fileRunner, input.maxFiles);

  if (discovered.error) {
    return {
      kind: "python",
      label: "python",
      project: "python",
      diagnostics: [],
      error: discovered.error,
    };
  }

  if (discovered.files.length === 0) {
    return {
      kind: "python",
      label: "python",
      project: "python",
      diagnostics: [],
      error: "No Python files found.",
    };
  }

  const runner = input.commandRunner || runDiagnosticCommand;
  const diagnostics: TypeScriptDiagnostic[] = [];
  for (const file of discovered.files) {
    const result = await runner(input.pythonCommand || "python3", ["-m", "py_compile", file], {
      cwd: input.dir,
      timeoutMs: input.timeoutMs,
    });
    if (result.exitCode === 0) continue;
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    const parsed = parsePythonDiagnostics(output, input.dir);
    diagnostics.push(...(parsed.length > 0 ? parsed : [{
      file,
      line: 1,
      column: 1,
      severity: "error" as const,
      code: "PY_COMPILE",
      message: output.trim() || `python compile exited with ${result.exitCode}`,
      language: "python" as const,
    }]));
  }

  return {
    kind: "python",
    label: `python (${discovered.files.length} files)`,
    project: "python",
    diagnostics,
  };
}

export async function loadGoDiagnostics(input: {
  dir: string;
  files?: string[];
  commandRunner?: DiagnosticCommandRunner;
  fileRunner?: WorkspaceCommandRunner;
  goCommand?: string;
  timeoutMs?: number;
  maxFiles?: number;
}): Promise<TypeScriptDiagnosticResult> {
  const discovered = input.files
    ? { files: input.files.slice(0, input.maxFiles || 300), error: undefined }
    : await discoverGoFiles(input.dir, input.fileRunner, input.maxFiles);

  if (discovered.error) {
    return {
      kind: "go",
      label: "go",
      project: "go",
      diagnostics: [],
      error: discovered.error,
    };
  }

  if (discovered.files.length === 0 && !existsSync(join(input.dir, "go.mod"))) {
    return {
      kind: "go",
      label: "go",
      project: "go",
      diagnostics: [],
      error: "No Go files found.",
    };
  }

  const runner = input.commandRunner || runDiagnosticCommand;
  const result = await runner(input.goCommand || "go", ["test", "./..."], {
    cwd: input.dir,
    timeoutMs: input.timeoutMs,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const diagnostics = parseGoDiagnostics(output, input.dir);
  return {
    kind: "go",
    label: discovered.files.length > 0 ? `go (${discovered.files.length} files)` : "go",
    project: "go",
    diagnostics,
    error: result.exitCode > 0 && diagnostics.length === 0
      ? output.trim() || `go test exited with ${result.exitCode}`
      : undefined,
  };
}

export async function loadRustDiagnostics(input: {
  dir: string;
  files?: string[];
  commandRunner?: DiagnosticCommandRunner;
  fileRunner?: WorkspaceCommandRunner;
  cargoCommand?: string;
  timeoutMs?: number;
  maxFiles?: number;
}): Promise<TypeScriptDiagnosticResult> {
  const discovered = input.files
    ? { files: input.files.slice(0, input.maxFiles || 300), error: undefined }
    : await discoverRustFiles(input.dir, input.fileRunner, input.maxFiles);

  if (discovered.error) {
    return {
      kind: "rust",
      label: "rust",
      project: "rust",
      diagnostics: [],
      error: discovered.error,
    };
  }

  if (discovered.files.length === 0 && !existsSync(join(input.dir, "Cargo.toml"))) {
    return {
      kind: "rust",
      label: "rust",
      project: "rust",
      diagnostics: [],
      error: "No Rust files found.",
    };
  }

  const runner = input.commandRunner || runDiagnosticCommand;
  const result = await runner(input.cargoCommand || "cargo", ["check", "--workspace", "--message-format", "short"], {
    cwd: input.dir,
    timeoutMs: input.timeoutMs,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const diagnostics = parseRustDiagnostics(output, input.dir);
  return {
    kind: "rust",
    label: discovered.files.length > 0 ? `rust (${discovered.files.length} files)` : "rust",
    project: "rust",
    diagnostics,
    error: result.exitCode > 0 && diagnostics.length === 0
      ? output.trim() || `cargo check exited with ${result.exitCode}`
      : undefined,
  };
}

export function resolveDiagnosticsKind(request?: string): { kind: DiagnosticsKind; project?: string } {
  const value = request?.trim();
  const normalized = value?.toLowerCase();
  if (normalized === "all" || normalized === "--all" || normalized === "workspace") {
    return { kind: "all" };
  }
  if (normalized === "python" || normalized === "py" || normalized === "--python") {
    return { kind: "python" };
  }
  if (normalized === "go" || normalized === "golang" || normalized === "--go") {
    return { kind: "go" };
  }
  if (normalized === "rust" || normalized === "rs" || normalized === "cargo" || normalized === "--rust") {
    return { kind: "rust" };
  }
  return { kind: "typescript", project: value || undefined };
}

export function diagnosticsRequestLabel(request?: string): string {
  const selection = resolveDiagnosticsKind(request);
  if (selection.kind === "all") return "workspace diagnostics";
  if (selection.kind === "python") return "Python diagnostics";
  if (selection.kind === "go") return "Go diagnostics";
  if (selection.kind === "rust") return "Rust diagnostics";
  return selection.project
    ? `TypeScript diagnostics for ${selection.project}`
    : "TypeScript diagnostics";
}

export async function loadAllWorkspaceDiagnostics(input: {
  dir: string;
  commandRunner?: DiagnosticCommandRunner;
  projectRunner?: WorkspaceCommandRunner;
  timeoutMs?: number;
}): Promise<TypeScriptDiagnosticResult> {
  const results: TypeScriptDiagnosticResult[] = [];
  const diagnostics: TypeScriptDiagnostic[] = [];
  const projects: string[] = [];

  const discoveredTypeScript = await discoverTypeScriptProjects(input.dir, input.projectRunner);
  if (discoveredTypeScript.error) {
    const result = {
      kind: "typescript" as const,
      label: "typescript",
      project: "typescript",
      diagnostics: [diagnosticToolError("typescript", "typescript", discoveredTypeScript.error)],
      error: discoveredTypeScript.error,
    };
    results.push(result);
    diagnostics.push(...result.diagnostics);
  } else {
    projects.push(...discoveredTypeScript.projects);
    for (const project of discoveredTypeScript.projects) {
      const result = await loadTypeScriptDiagnostics({
        dir: input.dir,
        project,
        commandRunner: input.commandRunner,
        projectRunner: async () => ({ stdout: discoveredTypeScript.projects.join("\n"), stderr: "" }),
        timeoutMs: input.timeoutMs,
      });
      const fixed = result.error
        ? { ...result, diagnostics: [...result.diagnostics, diagnosticToolError("typescript", project, result.error)] }
        : result;
      results.push(fixed);
      diagnostics.push(...fixed.diagnostics);
    }
  }

  const python = await loadPythonDiagnostics({
    dir: input.dir,
    commandRunner: input.commandRunner,
    fileRunner: input.projectRunner,
    timeoutMs: input.timeoutMs,
  });
  if (python.error !== "No Python files found.") {
    const fixed = python.error
      ? { ...python, diagnostics: [...python.diagnostics, diagnosticToolError("python", "python", python.error)] }
      : python;
    results.push(fixed);
    diagnostics.push(...fixed.diagnostics);
  }

  const go = await loadGoDiagnostics({
    dir: input.dir,
    commandRunner: input.commandRunner,
    fileRunner: input.projectRunner,
    timeoutMs: input.timeoutMs,
  });
  if (go.error !== "No Go files found.") {
    const fixed = go.error
      ? { ...go, diagnostics: [...go.diagnostics, diagnosticToolError("go", "go", go.error)] }
      : go;
    results.push(fixed);
    diagnostics.push(...fixed.diagnostics);
  }

  const rust = await loadRustDiagnostics({
    dir: input.dir,
    commandRunner: input.commandRunner,
    fileRunner: input.projectRunner,
    timeoutMs: input.timeoutMs,
  });
  if (rust.error !== "No Rust files found.") {
    const fixed = rust.error
      ? { ...rust, diagnostics: [...rust.diagnostics, diagnosticToolError("rust", "rust", rust.error)] }
      : rust;
    results.push(fixed);
    diagnostics.push(...fixed.diagnostics);
  }

  const labels = results.map((result) => result.label || result.project || result.kind || "diagnostics");
  if (results.length === 0) {
    return {
      kind: "all",
      label: "all",
      project: "all",
      diagnostics: [],
      projects,
      results,
      error: "No TypeScript, Python, or Go projects found.",
    };
  }

  return {
    kind: "all",
    label: `all (${labels.join(", ")})`,
    project: "all",
    diagnostics,
    projects,
    results,
  };
}

export async function loadWorkspaceDiagnostics(input: {
  dir: string;
  request?: string;
  commandRunner?: DiagnosticCommandRunner;
  projectRunner?: WorkspaceCommandRunner;
  timeoutMs?: number;
}): Promise<TypeScriptDiagnosticResult> {
  const selection = resolveDiagnosticsKind(input.request);
  if (selection.kind === "all") {
    return loadAllWorkspaceDiagnostics({
      dir: input.dir,
      commandRunner: input.commandRunner,
      projectRunner: input.projectRunner,
      timeoutMs: input.timeoutMs,
    });
  }

  if (selection.kind === "python") {
    return loadPythonDiagnostics({
      dir: input.dir,
      commandRunner: input.commandRunner,
      fileRunner: input.projectRunner,
      timeoutMs: input.timeoutMs,
    });
  }

  if (selection.kind === "go") {
    return loadGoDiagnostics({
      dir: input.dir,
      commandRunner: input.commandRunner,
      fileRunner: input.projectRunner,
      timeoutMs: input.timeoutMs,
    });
  }

  if (selection.kind === "rust") {
    return loadRustDiagnostics({
      dir: input.dir,
      commandRunner: input.commandRunner,
      fileRunner: input.projectRunner,
      timeoutMs: input.timeoutMs,
    });
  }

  return loadTypeScriptDiagnostics({
    dir: input.dir,
    project: selection.project,
    commandRunner: input.commandRunner,
    projectRunner: input.projectRunner,
    timeoutMs: input.timeoutMs,
  });
}
