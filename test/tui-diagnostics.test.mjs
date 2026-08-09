import test from "node:test";
import assert from "node:assert/strict";

import {
  discoverGoFiles,
  discoverPythonFiles,
  discoverRustFiles,
  discoverTypeScriptProjects,
  diagnosticsRequestLabel,
  loadAllWorkspaceDiagnostics,
  loadGoDiagnostics,
  loadPythonDiagnostics,
  loadRustDiagnostics,
  loadTypeScriptDiagnostics,
  loadWorkspaceDiagnostics,
  parseGoDiagnostics,
  parsePythonDiagnostics,
  parseRustDiagnostics,
  parseTypeScriptDiagnostics,
  resolveDiagnosticsKind,
  selectTypeScriptProject,
} from "../dist/tui-diagnostics.js";

test("parseTypeScriptDiagnostics extracts TypeScript error lines", () => {
  const diagnostics = parseTypeScriptDiagnostics([
    "packages/cli/src/tui.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.",
    "noise",
    "apps/web/src/App.tsx(3,1): warning TS6133: 'React' is declared but its value is never read.",
  ].join("\n"), "/repo");

  assert.deepEqual(diagnostics, [
    {
      file: "packages/cli/src/tui.ts",
      line: 10,
      column: 5,
      severity: "error",
      code: "TS2322",
      message: "Type 'string' is not assignable to type 'number'.",
      language: "typescript",
    },
    {
      file: "apps/web/src/App.tsx",
      line: 3,
      column: 1,
      severity: "warning",
      code: "TS6133",
      message: "'React' is declared but its value is never read.",
      language: "typescript",
    },
  ]);
});

test("parsePythonDiagnostics extracts py_compile syntax errors", () => {
  const diagnostics = parsePythonDiagnostics([
    "  File \"/repo/src/app.py\", line 3",
    "    if True print('bad')",
    "            ^^^^^",
    "SyntaxError: invalid syntax",
  ].join("\n"), "/repo");

  assert.deepEqual(diagnostics, [{
    file: "src/app.py",
    line: 3,
    column: 1,
    severity: "error",
    code: "SyntaxError",
    message: "invalid syntax",
    language: "python",
  }]);
});

test("parseGoDiagnostics extracts go compiler output", () => {
  const diagnostics = parseGoDiagnostics([
    "# example.com/app",
    "./main.go:6:13: undefined: missingValue",
    "pkg/handler.go:12:1: syntax error: unexpected }, expected expression",
  ].join("\n"), "/repo");

  assert.deepEqual(diagnostics, [
    {
      file: "main.go",
      line: 6,
      column: 13,
      severity: "error",
      code: "GO",
      message: "undefined: missingValue",
      language: "go",
    },
    {
      file: "pkg/handler.go",
      line: 12,
      column: 1,
      severity: "error",
      code: "GO",
      message: "syntax error: unexpected }, expected expression",
      language: "go",
    },
  ]);
});

test("parseRustDiagnostics extracts cargo short diagnostics", () => {
  const diagnostics = parseRustDiagnostics([
    "src/main.rs:6:13: error[E0425]: cannot find value `missing` in this scope",
    "src/lib.rs:12:5: warning: unused variable: `result`",
  ].join("\n"), "/repo");

  assert.deepEqual(diagnostics, [
    {
      file: "src/main.rs",
      line: 6,
      column: 13,
      severity: "error",
      code: "E0425",
      message: "cannot find value `missing` in this scope",
      language: "rust",
    },
    {
      file: "src/lib.rs",
      line: 12,
      column: 5,
      severity: "warning",
      code: "WARNING",
      message: "unused variable: `result`",
      language: "rust",
    },
  ]);
});

test("selectTypeScriptProject handles exact, suffix, and ambiguous selections", () => {
  const projects = ["apps/web/tsconfig.json", "packages/cli/tsconfig.json"];

  assert.equal(selectTypeScriptProject(projects), null);
  assert.equal(selectTypeScriptProject(projects, "packages/cli/tsconfig.json"), "packages/cli/tsconfig.json");
  assert.equal(selectTypeScriptProject(projects, "cli/tsconfig.json"), "packages/cli/tsconfig.json");
  assert.equal(selectTypeScriptProject(projects, "custom/tsconfig.json"), "custom/tsconfig.json");
  assert.equal(selectTypeScriptProject(["tsconfig.json"]), "tsconfig.json");
});

test("discoverTypeScriptProjects reads rg results through an injectable runner", async () => {
  const result = await discoverTypeScriptProjects("/repo", async () => ({
    stdout: "/repo/packages/cli/tsconfig.json\n/repo/apps/web/tsconfig.json\n",
    stderr: "",
  }));

  assert.deepEqual(result, {
    projects: ["apps/web/tsconfig.json", "packages/cli/tsconfig.json"],
  });
});

test("discoverPythonFiles reads Python files through an injectable runner", async () => {
  const result = await discoverPythonFiles("/repo", async () => ({
    stdout: "/repo/src/app.py\n/repo/.venv/lib/ignored.py\n/repo/tests/test_app.py\n",
    stderr: "",
  }));

  assert.deepEqual(result, {
    files: ["src/app.py", "tests/test_app.py"],
  });
});

test("discoverGoFiles reads Go files through an injectable runner", async () => {
  const result = await discoverGoFiles("/repo", async () => ({
    stdout: "/repo/main.go\n/repo/vendor/ignored.go\n/repo/pkg/handler.go\n",
    stderr: "",
  }));

  assert.deepEqual(result, {
    files: ["main.go", "pkg/handler.go"],
  });
});

test("discoverRustFiles reads Rust files through an injectable runner", async () => {
  const result = await discoverRustFiles("/repo", async () => ({
    stdout: "/repo/src/main.rs\n/repo/target/debug/build.rs\n/repo/src/lib.rs\n",
    stderr: "",
  }));

  assert.deepEqual(result, {
    files: ["src/lib.rs", "src/main.rs"],
  });
});

test("loadTypeScriptDiagnostics reports ambiguous projects before running tsc", async () => {
  const result = await loadTypeScriptDiagnostics({
    dir: "/repo",
    projectRunner: async () => ({
      stdout: "/repo/packages/cli/tsconfig.json\n/repo/apps/web/tsconfig.json\n",
      stderr: "",
    }),
    commandRunner: async () => {
      throw new Error("should not run tsc without a selected project");
    },
  });

  assert.equal(result.error, "Multiple TypeScript projects found. Use /diagnostics <tsconfig-path>.");
  assert.deepEqual(result.projects, ["apps/web/tsconfig.json", "packages/cli/tsconfig.json"]);
  assert.deepEqual(result.diagnostics, []);
});

test("loadTypeScriptDiagnostics runs tsc for the selected project and parses diagnostics", async () => {
  const calls = [];
  const result = await loadTypeScriptDiagnostics({
    dir: "/repo",
    project: "packages/cli/tsconfig.json",
    projectRunner: async () => ({
      stdout: "/repo/packages/cli/tsconfig.json\n/repo/apps/web/tsconfig.json\n",
      stderr: "",
    }),
    commandRunner: async (file, args, options) => {
      calls.push({ file, args, options });
      return {
        stdout: "packages/cli/src/index.ts(4,7): error TS1005: ';' expected.",
        stderr: "",
        exitCode: 2,
      };
    },
  });

  assert.equal(result.project, "packages/cli/tsconfig.json");
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].code, "TS1005");
  assert.deepEqual(calls, [
    {
      file: "pnpm",
      args: ["exec", "tsc", "-p", "packages/cli/tsconfig.json", "--noEmit", "--pretty", "false"],
      options: { cwd: "/repo", timeoutMs: undefined },
    },
  ]);
});

test("loadPythonDiagnostics compiles discovered files and reports syntax errors", async () => {
  const calls = [];
  const result = await loadPythonDiagnostics({
    dir: "/repo",
    fileRunner: async () => ({
      stdout: "/repo/src/app.py\n/repo/src/ok.py\n",
      stderr: "",
    }),
    commandRunner: async (file, args, options) => {
      calls.push({ file, args, options });
      if (args.at(-1) === "src/ok.py") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return {
        stdout: "",
        stderr: [
          "  File \"/repo/src/app.py\", line 2",
          "    if True print('bad')",
          "SyntaxError: invalid syntax",
        ].join("\n"),
        exitCode: 1,
      };
    },
  });

  assert.equal(result.kind, "python");
  assert.equal(result.project, "python");
  assert.equal(result.label, "python (2 files)");
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].code, "SyntaxError");
  assert.deepEqual(calls, [
    {
      file: "python3",
      args: ["-m", "py_compile", "src/app.py"],
      options: { cwd: "/repo", timeoutMs: undefined },
    },
    {
      file: "python3",
      args: ["-m", "py_compile", "src/ok.py"],
      options: { cwd: "/repo", timeoutMs: undefined },
    },
  ]);
});

test("loadGoDiagnostics runs go test and parses compiler diagnostics", async () => {
  const calls = [];
  const result = await loadGoDiagnostics({
    dir: "/repo",
    fileRunner: async () => ({
      stdout: "/repo/main.go\n/repo/pkg/handler.go\n",
      stderr: "",
    }),
    commandRunner: async (file, args, options) => {
      calls.push({ file, args, options });
      return {
        stdout: "# example.com/app\n./main.go:6:13: undefined: missingValue\nFAIL\texample.com/app [build failed]",
        stderr: "",
        exitCode: 1,
      };
    },
  });

  assert.equal(result.kind, "go");
  assert.equal(result.project, "go");
  assert.equal(result.label, "go (2 files)");
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].code, "GO");
  assert.equal(result.error, undefined);
  assert.deepEqual(calls, [{
    file: "go",
    args: ["test", "./..."],
    options: { cwd: "/repo", timeoutMs: undefined },
  }]);
});

test("loadRustDiagnostics runs cargo check and parses compiler diagnostics", async () => {
  const calls = [];
  const result = await loadRustDiagnostics({
    dir: "/repo",
    fileRunner: async () => ({
      stdout: "/repo/src/main.rs\n/repo/src/lib.rs\n",
      stderr: "",
    }),
    commandRunner: async (file, args, options) => {
      calls.push({ file, args, options });
      return {
        stdout: "src/main.rs:6:13: error[E0425]: cannot find value `missing` in this scope",
        stderr: "",
        exitCode: 101,
      };
    },
  });

  assert.equal(result.kind, "rust");
  assert.equal(result.project, "rust");
  assert.equal(result.label, "rust (2 files)");
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].code, "E0425");
  assert.equal(result.error, undefined);
  assert.deepEqual(calls, [{
    file: "cargo",
    args: ["check", "--workspace", "--message-format", "short"],
    options: { cwd: "/repo", timeoutMs: undefined },
  }]);
});

test("loadWorkspaceDiagnostics dispatches TypeScript and Python requests", async () => {
  assert.deepEqual(resolveDiagnosticsKind("all"), { kind: "all" });
  assert.deepEqual(resolveDiagnosticsKind("python"), { kind: "python" });
  assert.deepEqual(resolveDiagnosticsKind("go"), { kind: "go" });
  assert.deepEqual(resolveDiagnosticsKind("rust"), { kind: "rust" });
  assert.deepEqual(resolveDiagnosticsKind("packages/cli/tsconfig.json"), {
    kind: "typescript",
    project: "packages/cli/tsconfig.json",
  });

  const python = await loadWorkspaceDiagnostics({
    dir: "/repo",
    request: "py",
    projectRunner: async () => ({ stdout: "/repo/src/app.py\n", stderr: "" }),
    commandRunner: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  });
  assert.equal(python.kind, "python");
  assert.equal(python.diagnostics.length, 0);

  const go = await loadWorkspaceDiagnostics({
    dir: "/repo",
    request: "golang",
    projectRunner: async () => ({ stdout: "/repo/main.go\n", stderr: "" }),
    commandRunner: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  });
  assert.equal(go.kind, "go");
  assert.equal(go.diagnostics.length, 0);

  const rust = await loadWorkspaceDiagnostics({
    dir: "/repo",
    request: "rs",
    projectRunner: async () => ({ stdout: "/repo/src/main.rs\n", stderr: "" }),
    commandRunner: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  });
  assert.equal(rust.kind, "rust");
  assert.equal(rust.diagnostics.length, 0);
});

test("diagnosticsRequestLabel names aggregate and language requests", () => {
  assert.equal(diagnosticsRequestLabel("all"), "workspace diagnostics");
  assert.equal(diagnosticsRequestLabel("python"), "Python diagnostics");
  assert.equal(diagnosticsRequestLabel("go"), "Go diagnostics");
  assert.equal(diagnosticsRequestLabel("rust"), "Rust diagnostics");
  assert.equal(diagnosticsRequestLabel("packages/cli/tsconfig.json"), "TypeScript diagnostics for packages/cli/tsconfig.json");
  assert.equal(diagnosticsRequestLabel(), "TypeScript diagnostics");
});

test("loadAllWorkspaceDiagnostics aggregates TypeScript, Python, Go, and Rust diagnostics", async () => {
  const projectCalls = [];
  const commandCalls = [];
  const projectRunner = async (file, args) => {
    projectCalls.push({ file, args });
    const joined = args.join(" ");
    if (joined.includes("tsconfig.json")) {
      return { stdout: "/repo/packages/cli/tsconfig.json\n/repo/apps/web/tsconfig.json\n", stderr: "" };
    }
    if (joined.includes("*.py")) {
      return { stdout: "/repo/scripts/bad.py\n", stderr: "" };
    }
    if (joined.includes("*.go")) {
      return { stdout: "/repo/main.go\n", stderr: "" };
    }
    if (joined.includes("*.rs")) {
      return { stdout: "/repo/src/main.rs\n", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };

  const result = await loadAllWorkspaceDiagnostics({
    dir: "/repo",
    projectRunner,
    commandRunner: async (file, args, options) => {
      commandCalls.push({ file, args, options });
      if (file === "pnpm" && args.includes("packages/cli/tsconfig.json")) {
        return {
          stdout: "packages/cli/src/index.ts(4,7): error TS1005: ';' expected.",
          stderr: "",
          exitCode: 2,
        };
      }
      if (file === "pnpm") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (file === "python3") {
        return {
          stdout: "",
          stderr: [
            "  File \"/repo/scripts/bad.py\", line 2",
            "    if True print('bad')",
            "SyntaxError: invalid syntax",
          ].join("\n"),
          exitCode: 1,
        };
      }
      if (file === "go") {
        return {
          stdout: "# example.com/app\n./main.go:6:13: undefined: missingValue",
          stderr: "",
          exitCode: 1,
        };
      }
      if (file === "cargo") {
        return {
          stdout: "src/main.rs:7:9: error[E0425]: cannot find value `missing` in this scope",
          stderr: "",
          exitCode: 101,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  });

  assert.equal(result.kind, "all");
  assert.equal(result.project, "all");
  assert.match(result.label, /packages\/cli\/tsconfig\.json/);
  assert.deepEqual(result.projects, ["apps/web/tsconfig.json", "packages/cli/tsconfig.json"]);
  assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ["TS1005", "SyntaxError", "GO", "E0425"]);
  assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.language), ["typescript", "python", "go", "rust"]);
  assert.equal(result.results.length, 5);
  assert.equal(commandCalls.filter((call) => call.file === "pnpm").length, 2);
  assert.equal(commandCalls.some((call) => call.file === "python3"), true);
  assert.equal(commandCalls.some((call) => call.file === "go"), true);
  assert.equal(commandCalls.some((call) => call.file === "cargo"), true);
  assert.equal(projectCalls.length, 4);
});

test("loadWorkspaceDiagnostics dispatches aggregate diagnostics", async () => {
  const result = await loadWorkspaceDiagnostics({
    dir: "/repo",
    request: "all",
    projectRunner: async (file, args) => {
      const joined = args.join(" ");
      if (joined.includes("*.py")) return { stdout: "/repo/src/app.py\n", stderr: "" };
      return { stdout: "", stderr: "" };
    },
    commandRunner: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  });

  assert.equal(result.kind, "all");
  assert.equal(result.project, "all");
  assert.equal(result.diagnostics.length, 0);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].kind, "python");
});
