import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  applyRename,
  filterSymbols,
  isSourceFile,
  loadRenamePreview,
  loadSymbolNavigation,
  loadWorkspaceSymbols,
  parseSymbolsFromText,
  scoreSymbolMatch,
} from "../dist/tui-symbols.js";

test("parseSymbolsFromText extracts common TypeScript, JavaScript, Python, Go, and Rust declarations", () => {
  const symbols = parseSymbolsFromText("src/example.ts", [
    "export interface AgentRecord {",
    "export type AgentState = 'idle';",
    "export enum RunStatus { Running }",
    "export class RoomDashboard {",
    "  async refreshRoom(): Promise<void> {",
    "    if (true) return;",
    "  }",
    "}",
    "export function loadRoom() {",
    "const runTask = async () => {};",
    "const value = 1;",
    "def python_symbol():",
    "func GoSymbol() {}",
    "pub mod runtime;",
    "pub struct RuntimeConfig {",
    "pub trait Runnable {",
    "pub enum RunState { Idle }",
    "pub const MAX_RUNS: usize = 4;",
    "pub async fn run_workspace() {}",
  ].join("\n"));

  assert.deepEqual(symbols.map((symbol) => [symbol.kind, symbol.name, symbol.line]), [
    ["interface", "AgentRecord", 1],
    ["type", "AgentState", 2],
    ["enum", "RunStatus", 3],
    ["class", "RoomDashboard", 4],
    ["method", "refreshRoom", 5],
    ["function", "loadRoom", 9],
    ["function", "runTask", 10],
    ["const", "value", 11],
    ["function", "python_symbol", 12],
    ["function", "GoSymbol", 13],
    ["module", "runtime", 14],
    ["struct", "RuntimeConfig", 15],
    ["trait", "Runnable", 16],
    ["enum", "RunState", 17],
    ["const", "MAX_RUNS", 18],
    ["function", "run_workspace", 19],
  ]);
});

test("parseSymbolsFromText classifies Python methods distinctly", () => {
  const symbols = parseSymbolsFromText("pkg/service.py", [
    "class PythonRoom:",
    "    async def refresh_python(self):",
    "        return True",
    "",
    "def top_level():",
    "    return PythonRoom()",
  ].join("\n"));

  assert.deepEqual(symbols.map((symbol) => [symbol.kind, symbol.name, symbol.line, symbol.column]), [
    ["class", "PythonRoom", 1, 7],
    ["method", "refresh_python", 2, 15],
    ["function", "top_level", 5, 5],
  ]);
});

test("symbol helpers filter source files and rank exact, prefix, substring, and fuzzy matches", () => {
  assert.equal(isSourceFile("src/app.tsx"), true);
  assert.equal(isSourceFile("src/main.rs"), true);
  assert.equal(isSourceFile("README.md"), false);

  const symbols = [
    { name: "RoomDashboard", kind: "class", path: "src/room.ts", line: 1, column: 1, signature: "class RoomDashboard" },
    { name: "loadRoom", kind: "function", path: "src/room.ts", line: 5, column: 1, signature: "function loadRoom()" },
    { name: "refreshDashboard", kind: "method", path: "src/dashboard.ts", line: 7, column: 3, signature: "refreshDashboard()" },
  ];

  assert.equal(scoreSymbolMatch(symbols[0], "RoomDashboard") > scoreSymbolMatch(symbols[0], "room"), true);
  assert.equal(filterSymbols(symbols, "load")[0].name, "loadRoom");
  assert.equal(filterSymbols(symbols, "roomd")[0].name, "RoomDashboard");
  assert.equal(filterSymbols(symbols, "missing").length, 0);
});

test("loadWorkspaceSymbols scans source files from rg output and applies the query", async () => {
  const dir = mkdtempSync(join(tmpdir(), "co-od-symbols-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/index.ts"), "export function loadWorkspace() {}\nconst hiddenValue = true;\n");
  writeFileSync(join(dir, "src/readme.md"), "# docs\n");

  const result = await loadWorkspaceSymbols({
    dir,
    query: "load",
    commandRunner: async () => ({
      stdout: `${dir}/src/index.ts\n${dir}/src/readme.md\n`,
      stderr: "",
    }),
  });

  assert.equal(result.error, undefined);
  assert.equal(result.scannedFiles, 1);
  assert.deepEqual(result.symbols.map((symbol) => symbol.name), ["loadWorkspace"]);
});

test("loadSymbolNavigation resolves a best matching symbol location", async () => {
  const dir = mkdtempSync(join(tmpdir(), "co-od-goto-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/index.ts"), "export function loadWorkspace() {}\n");

  const result = await loadSymbolNavigation({
    dir,
    query: "loadWorkspace",
    files: ["src/index.ts"],
  });

  assert.equal(result.error, undefined);
  assert.equal(result.symbol?.name, "loadWorkspace");
  assert.equal(result.message, "loadWorkspace function at src/index.ts:1:17");
});

test("loadSymbolNavigation uses TypeScript definitions across imports", async () => {
  const dir = mkdtempSync(join(tmpdir(), "co-od-ts-goto-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/index.ts"), [
    "export function loadWorkspace() {",
    "  return true;",
    "}",
  ].join("\n"));
  writeFileSync(join(dir, "src/usage.ts"), [
    "import { loadWorkspace } from './index';",
    "const result = loadWorkspace();",
  ].join("\n"));

  const result = await loadSymbolNavigation({
    dir,
    query: "loadWorkspace",
    files: ["src/usage.ts", "src/index.ts"],
  });

  assert.equal(result.error, undefined);
  assert.equal(result.source, "typescript");
  assert.equal(result.symbol?.path, "src/index.ts");
  assert.equal(result.symbol?.line, 1);
  assert.equal(result.symbol?.column, 17);
  assert.match(result.message, /TypeScript definition loadWorkspace function at src\/index\.ts:1:17/);
});

test("loadSymbolNavigation reports language-aware scan sources", async () => {
  const dir = mkdtempSync(join(tmpdir(), "co-od-language-goto-"));
  mkdirSync(join(dir, "pkg"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "pkg/service.py"), [
    "class Runner:",
    "    def refresh_room(self):",
    "        return True",
  ].join("\n"));
  writeFileSync(join(dir, "pkg/service.go"), [
    "package pkg",
    "func LoadWorkspace() bool { return true }",
  ].join("\n"));
  writeFileSync(join(dir, "src/lib.rs"), [
    "pub struct WorkspaceRunner;",
    "pub fn load_workspace() -> bool { true }",
  ].join("\n"));

  const python = await loadSymbolNavigation({
    dir,
    query: "refresh_room",
    files: ["pkg/service.py", "pkg/service.go", "src/lib.rs"],
  });
  const go = await loadSymbolNavigation({
    dir,
    query: "LoadWorkspace",
    files: ["pkg/service.py", "pkg/service.go", "src/lib.rs"],
  });
  const rust = await loadSymbolNavigation({
    dir,
    query: "WorkspaceRunner",
    files: ["pkg/service.py", "pkg/service.go", "src/lib.rs"],
  });

  assert.equal(python.source, "python");
  assert.match(python.message, /Python symbol refresh_room method at pkg\/service\.py:2:9/);
  assert.equal(go.source, "go");
  assert.match(go.message, /Go symbol LoadWorkspace function at pkg\/service\.go:2:6/);
  assert.equal(rust.source, "rust");
  assert.match(rust.message, /Rust symbol WorkspaceRunner struct at src\/lib\.rs:1:12/);
});

test("loadRenamePreview reports identifier occurrences without editing files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "co-od-rename-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/index.ts"), [
    "export function loadWorkspace() {}",
    "const result = loadWorkspace();",
    "const loadWorkspaceExtra = true;",
    "const label = 'loadWorkspace should not rename in strings';",
    "const template = `loadWorkspace should not rename in templates`;",
    "// loadWorkspace should not rename in comments",
    "/* loadWorkspace should not rename in block comments */",
  ].join("\n"));

  const result = await loadRenamePreview({
    dir,
    oldName: "loadWorkspace",
    newName: "loadProject",
    files: ["src/index.ts"],
  });

  assert.equal(result.error, undefined);
  assert.equal(result.symbol?.name, "loadWorkspace");
  assert.equal(result.occurrences.length, 2);
  assert.deepEqual(result.occurrences.map((occurrence) => [occurrence.line, occurrence.column]), [[1, 17], [2, 16]]);
  assert.match(result.message, /loadWorkspace -> loadProject: 2 occurrences/);
});

test("loadRenamePreview uses TypeScript rename locations across imports", async () => {
  const dir = mkdtempSync(join(tmpdir(), "co-od-ts-rename-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/index.ts"), [
    "export function loadWorkspace() {",
    "  return true;",
    "}",
    "const loadWorkspaceExtra = true;",
    "const label = 'loadWorkspace should stay in string';",
    "// loadWorkspace should stay in comment",
  ].join("\n"));
  writeFileSync(join(dir, "src/usage.ts"), [
    "import { loadWorkspace } from './index';",
    "const result = loadWorkspace();",
  ].join("\n"));

  const result = await loadRenamePreview({
    dir,
    oldName: "loadWorkspace",
    newName: "loadProject",
    files: ["src/index.ts", "src/usage.ts"],
  });

  assert.equal(result.error, undefined);
  assert.equal(result.source, "typescript");
  assert.equal(result.symbol?.name, "loadWorkspace");
  assert.deepEqual(result.occurrences.map((occurrence) => [occurrence.path, occurrence.line, occurrence.column]), [
    ["src/index.ts", 1, 17],
    ["src/usage.ts", 1, 10],
    ["src/usage.ts", 2, 16],
  ]);
  assert.equal(result.occurrences.some((occurrence) => occurrence.text.includes("loadWorkspaceExtra")), false);
  assert.match(result.message, /TypeScript rename preview loadWorkspace -> loadProject: 3 occurrences/);
});

test("loadRenamePreview uses Python-aware identifier locations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "co-od-py-rename-"));
  mkdirSync(join(dir, "pkg"), { recursive: true });
  writeFileSync(join(dir, "pkg/service.py"), [
    "def load_workspace():",
    "    return True",
    "",
    "def caller():",
    "    result = load_workspace()",
    "    text = 'load_workspace should not rename in strings'",
    "    # load_workspace should not rename in comments",
    "    return result",
  ].join("\n"));

  const result = await loadRenamePreview({
    dir,
    oldName: "load_workspace",
    newName: "load_project",
    files: ["pkg/service.py"],
  });

  assert.equal(result.error, undefined);
  assert.equal(result.source, "python");
  assert.equal(result.symbol?.name, "load_workspace");
  assert.deepEqual(result.occurrences.map((occurrence) => [occurrence.path, occurrence.line, occurrence.column]), [
    ["pkg/service.py", 1, 5],
    ["pkg/service.py", 5, 14],
  ]);
  assert.match(result.message, /Python rename preview load_workspace -> load_project: 2 occurrences/);
});

test("loadRenamePreview uses Go-aware identifier locations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "co-od-go-rename-"));
  mkdirSync(join(dir, "pkg"), { recursive: true });
  writeFileSync(join(dir, "pkg/service.go"), [
    "package pkg",
    "",
    "func loadWorkspace() bool {",
    "    return true",
    "}",
    "",
    "func caller() bool {",
    "    result := loadWorkspace()",
    "    text := \"loadWorkspace should not rename in strings\"",
    "    raw := `loadWorkspace should not rename in raw strings`",
    "    // loadWorkspace should not rename in comments",
    "    /* loadWorkspace should not rename in block comments */",
    "    _ = text",
    "    _ = raw",
    "    return result",
    "}",
  ].join("\n"));

  const result = await loadRenamePreview({
    dir,
    oldName: "loadWorkspace",
    newName: "loadProject",
    files: ["pkg/service.go"],
  });

  assert.equal(result.error, undefined);
  assert.equal(result.source, "go");
  assert.equal(result.symbol?.name, "loadWorkspace");
  assert.deepEqual(result.occurrences.map((occurrence) => [occurrence.path, occurrence.line, occurrence.column]), [
    ["pkg/service.go", 3, 6],
    ["pkg/service.go", 8, 15],
  ]);
  assert.match(result.message, /Go rename preview loadWorkspace -> loadProject: 2 occurrences/);
});

test("loadRenamePreview uses Rust-aware identifier locations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "co-od-rs-rename-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/lib.rs"), [
    "pub fn load_workspace<'a>(name: &'a str) -> bool {",
    "    name.is_empty()",
    "}",
    "",
    "pub fn caller() -> bool {",
    "    let result = load_workspace(\"demo\");",
    "    let text = \"load_workspace should not rename in strings\";",
    "    let raw = r#\"load_workspace should not rename in raw strings\"#;",
    "    // load_workspace should not rename in comments",
    "    /* load_workspace should not rename in block comments */",
    "    let ch = 'x';",
    "    result",
    "}",
  ].join("\n"));

  const result = await loadRenamePreview({
    dir,
    oldName: "load_workspace",
    newName: "load_project",
    files: ["src/lib.rs"],
  });

  assert.equal(result.error, undefined);
  assert.equal(result.source, "rust");
  assert.equal(result.symbol?.name, "load_workspace");
  assert.deepEqual(result.occurrences.map((occurrence) => [occurrence.path, occurrence.line, occurrence.column]), [
    ["src/lib.rs", 1, 8],
    ["src/lib.rs", 6, 18],
  ]);
  assert.match(result.message, /Rust rename preview load_workspace -> load_project: 2 occurrences/);
});

test("applyRename writes validated TypeScript rename locations across imports", async () => {
  const dir = mkdtempSync(join(tmpdir(), "co-od-apply-rename-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/index.ts"), [
    "export function loadWorkspace() {",
    "  return true;",
    "}",
    "const loadWorkspaceExtra = true;",
    "const label = 'loadWorkspace should stay in string';",
    "// loadWorkspace should stay in comment",
  ].join("\n"));
  writeFileSync(join(dir, "src/usage.ts"), [
    "import { loadWorkspace } from './index';",
    "const result = loadWorkspace();",
  ].join("\n"));

  const result = await applyRename({
    dir,
    oldName: "loadWorkspace",
    newName: "loadProject",
    files: ["src/index.ts", "src/usage.ts"],
  });

  assert.equal(result.error, undefined);
  assert.equal(result.source, "typescript");
  assert.deepEqual(result.changedFiles, ["src/index.ts", "src/usage.ts"]);
  assert.deepEqual(result.fileChanges.map((change) => change.path), ["src/index.ts", "src/usage.ts"]);
  assert.match(result.fileChanges[0].before, /loadWorkspace/);
  assert.match(result.fileChanges[0].after, /loadProject/);
  assert.equal(result.occurrences.length, 3);
  assert.match(readFileSync(join(dir, "src/index.ts"), "utf8"), /export function loadProject\(\)/);
  assert.match(readFileSync(join(dir, "src/index.ts"), "utf8"), /loadWorkspaceExtra/);
  assert.match(readFileSync(join(dir, "src/index.ts"), "utf8"), /'loadWorkspace should stay in string'/);
  assert.match(readFileSync(join(dir, "src/index.ts"), "utf8"), /\/\/ loadWorkspace should stay in comment/);
  assert.match(readFileSync(join(dir, "src/usage.ts"), "utf8"), /import \{ loadProject \}/);
  assert.match(readFileSync(join(dir, "src/usage.ts"), "utf8"), /const result = loadProject\(\)/);
});

test("applyRename writes Python-aware rename locations without touching strings or comments", async () => {
  const dir = mkdtempSync(join(tmpdir(), "co-od-py-apply-rename-"));
  mkdirSync(join(dir, "pkg"), { recursive: true });
  writeFileSync(join(dir, "pkg/service.py"), [
    "class Runner:",
    "    def load_workspace(self):",
    "        return load_workspace_helper()",
    "",
    "def load_workspace_helper():",
    "    text = \"load_workspace_helper should stay in string\"",
    "    # load_workspace_helper should stay in comment",
    "    return True",
  ].join("\n"));

  const result = await applyRename({
    dir,
    oldName: "load_workspace_helper",
    newName: "load_project_helper",
    files: ["pkg/service.py"],
  });

  const text = readFileSync(join(dir, "pkg/service.py"), "utf8");
  assert.equal(result.error, undefined);
  assert.equal(result.source, "python");
  assert.deepEqual(result.changedFiles, ["pkg/service.py"]);
  assert.equal(result.occurrences.length, 2);
  assert.match(text, /return load_project_helper\(\)/);
  assert.match(text, /def load_project_helper\(\):/);
  assert.match(text, /"load_workspace_helper should stay in string"/);
  assert.match(text, /# load_workspace_helper should stay in comment/);
});

test("applyRename writes Go-aware rename locations without touching strings or comments", async () => {
  const dir = mkdtempSync(join(tmpdir(), "co-od-go-apply-rename-"));
  mkdirSync(join(dir, "pkg"), { recursive: true });
  writeFileSync(join(dir, "pkg/service.go"), [
    "package pkg",
    "",
    "func loadWorkspace() bool {",
    "    return true",
    "}",
    "",
    "func caller() bool {",
    "    result := loadWorkspace()",
    "    text := \"loadWorkspace should stay in string\"",
    "    // loadWorkspace should stay in comment",
    "    return result",
    "}",
  ].join("\n"));

  const result = await applyRename({
    dir,
    oldName: "loadWorkspace",
    newName: "loadProject",
    files: ["pkg/service.go"],
  });

  const text = readFileSync(join(dir, "pkg/service.go"), "utf8");
  assert.equal(result.error, undefined);
  assert.equal(result.source, "go");
  assert.deepEqual(result.changedFiles, ["pkg/service.go"]);
  assert.equal(result.occurrences.length, 2);
  assert.match(text, /func loadProject\(\) bool/);
  assert.match(text, /result := loadProject\(\)/);
  assert.match(text, /"loadWorkspace should stay in string"/);
  assert.match(text, /\/\/ loadWorkspace should stay in comment/);
});

test("applyRename writes Rust-aware rename locations without touching strings or comments", async () => {
  const dir = mkdtempSync(join(tmpdir(), "co-od-rs-apply-rename-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/lib.rs"), [
    "pub fn load_workspace<'a>(name: &'a str) -> bool {",
    "    name.is_empty()",
    "}",
    "",
    "pub fn caller() -> bool {",
    "    let result = load_workspace(\"demo\");",
    "    let text = \"load_workspace should stay in string\";",
    "    let raw = r#\"load_workspace should stay in raw string\"#;",
    "    // load_workspace should stay in comment",
    "    result",
    "}",
  ].join("\n"));

  const result = await applyRename({
    dir,
    oldName: "load_workspace",
    newName: "load_project",
    files: ["src/lib.rs"],
  });

  const text = readFileSync(join(dir, "src/lib.rs"), "utf8");
  assert.equal(result.error, undefined);
  assert.equal(result.source, "rust");
  assert.deepEqual(result.changedFiles, ["src/lib.rs"]);
  assert.equal(result.occurrences.length, 2);
  assert.match(text, /pub fn load_project<'a>/);
  assert.match(text, /let result = load_project\("demo"\)/);
  assert.match(text, /"load_workspace should stay in string"/);
  assert.match(text, /r#"load_workspace should stay in raw string"#/);
  assert.match(text, /\/\/ load_workspace should stay in comment/);
});

test("loadRenamePreview validates input and missing symbols", async () => {
  assert.match((await loadRenamePreview({
    dir: "/tmp",
    oldName: "loadWorkspace",
    newName: "bad-name",
    files: [],
  })).message, /Invalid new symbol name/);

  assert.match((await loadRenamePreview({
    dir: "/tmp",
    oldName: "missing",
    newName: "nextName",
    files: [],
  })).message, /No symbol matched missing/);
});
