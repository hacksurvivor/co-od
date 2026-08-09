import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  listWorkspaceFiles,
  workspaceRelativePath,
  type WorkspaceCommandRunner,
} from "./tui-workspace.js";
import type { TuiFileUndoChange } from "./tui-undo.js";

export type TuiSymbolKind =
  | "class"
  | "const"
  | "enum"
  | "function"
  | "interface"
  | "method"
  | "module"
  | "struct"
  | "trait"
  | "type";

export interface TuiSymbol {
  name: string;
  kind: TuiSymbolKind;
  path: string;
  line: number;
  column: number;
  signature: string;
}

export interface TuiSymbolResult {
  query: string;
  symbols: TuiSymbol[];
  scannedFiles: number;
  error?: string;
}

export interface TuiSymbolNavigationResult {
  query: string;
  scannedFiles: number;
  symbol?: TuiSymbol;
  source?: "scan" | "typescript" | "python" | "go" | "rust";
  error?: string;
  message: string;
}

export interface TuiRenameOccurrence {
  path: string;
  line: number;
  column: number;
  text: string;
}

export interface TuiRenamePreviewResult {
  oldName: string;
  newName: string;
  scannedFiles: number;
  occurrences: TuiRenameOccurrence[];
  symbol?: TuiSymbol;
  source?: "scan" | "typescript" | "python" | "go" | "rust";
  error?: string;
  message: string;
}

export interface TuiRenameApplyResult {
  oldName: string;
  newName: string;
  scannedFiles: number;
  occurrences: TuiRenameOccurrence[];
  changedFiles: string[];
  fileChanges: TuiFileUndoChange[];
  symbol?: TuiSymbol;
  source?: "scan" | "typescript" | "python" | "go" | "rust";
  error?: string;
  message: string;
}

const SOURCE_FILE_RE = /\.(cjs|cts|jsx|mjs|mts|ts|tsx|js|py|go|rs)$/;
const TYPESCRIPT_SOURCE_FILE_RE = /\.(cjs|cts|jsx|mjs|mts|ts|tsx|js)$/;
const PYTHON_SOURCE_FILE_RE = /\.py$/;
const GO_SOURCE_FILE_RE = /\.go$/;
const RUST_SOURCE_FILE_RE = /\.rs$/;
const CONTROL_WORDS = new Set(["for", "if", "switch", "while", "catch"]);

interface SymbolPattern {
  kind: TuiSymbolKind;
  pattern: RegExp;
}

const SYMBOL_PATTERNS: SymbolPattern[] = [
  { kind: "function", pattern: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/ },
  { kind: "class", pattern: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)\b/ },
  { kind: "interface", pattern: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/ },
  { kind: "type", pattern: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\b/ },
  { kind: "enum", pattern: /^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)\b/ },
  { kind: "function", pattern: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/ },
  { kind: "const", pattern: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/ },
  { kind: "function", pattern: /^\s*(?:export\s+)?func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)\b/ },
  { kind: "function", pattern: /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\b/ },
  { kind: "module", pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_][\w]*)\b/ },
  { kind: "struct", pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_][\w]*)\b/ },
  { kind: "trait", pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_][\w]*)\b/ },
  { kind: "enum", pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_][\w]*)\b/ },
  { kind: "type", pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_][\w]*)\b/ },
  { kind: "const", pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+([A-Za-z_][\w]*)\b/ },
  { kind: "function", pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)\b/ },
];

export function isSourceFile(path: string): boolean {
  return SOURCE_FILE_RE.test(path);
}

export function parseSymbolsFromText(path: string, text: string): TuiSymbol[] {
  const symbols: TuiSymbol[] = [];
  const lines = text.split(/\r?\n/);

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#")) return;

    if (PYTHON_SOURCE_FILE_RE.test(path)) {
      const pythonSymbol = pythonSymbolFromLine({ path, line, lineNumber: index + 1 });
      if (pythonSymbol) {
        symbols.push(pythonSymbol);
        return;
      }
    }

    for (const entry of SYMBOL_PATTERNS) {
      const match = line.match(entry.pattern);
      if (!match) continue;
      symbols.push(symbolFromMatch({
        path,
        line,
        lineNumber: index + 1,
        kind: entry.kind,
        name: match[1],
      }));
      return;
    }

    const method = line.match(/^\s+(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[:{]/);
    if (method && !CONTROL_WORDS.has(method[1])) {
      symbols.push(symbolFromMatch({
        path,
        line,
        lineNumber: index + 1,
        kind: "method",
        name: method[1],
      }));
    }
  });

  return symbols;
}

function pythonSymbolFromLine(input: {
  path: string;
  line: string;
  lineNumber: number;
}): TuiSymbol | null {
  const classMatch = input.line.match(/^(\s*)class\s+([A-Za-z_][\w]*)\b/);
  if (classMatch) {
    return symbolFromMatch({
      path: input.path,
      line: input.line,
      lineNumber: input.lineNumber,
      kind: "class",
      name: classMatch[2],
    });
  }

  const defMatch = input.line.match(/^(\s*)(?:async\s+)?def\s+([A-Za-z_][\w]*)\b/);
  if (!defMatch) return null;
  return symbolFromMatch({
    path: input.path,
    line: input.line,
    lineNumber: input.lineNumber,
    kind: defMatch[1].length > 0 ? "method" : "function",
    name: defMatch[2],
  });
}

function symbolFromMatch(input: {
  path: string;
  line: string;
  lineNumber: number;
  kind: TuiSymbolKind;
  name: string;
}): TuiSymbol {
  return {
    name: input.name,
    kind: input.kind,
    path: input.path,
    line: input.lineNumber,
    column: Math.max(1, input.line.indexOf(input.name) + 1),
    signature: input.line.trim(),
  };
}

export function scoreSymbolMatch(symbol: TuiSymbol, query: string): number {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return 1;

  const name = symbol.name.toLowerCase();
  const haystack = `${symbol.name} ${symbol.kind} ${symbol.path}`.toLowerCase();
  if (name === normalized) return 1000;
  if (name.startsWith(normalized)) return 800 + normalized.length;
  if (haystack.includes(normalized)) return 500 + normalized.length;

  let score = 0;
  let queryIndex = 0;
  for (let i = 0; i < haystack.length && queryIndex < normalized.length; i++) {
    if (haystack[i] === normalized[queryIndex]) {
      score += i === 0 || haystack[i - 1] === "/" || haystack[i - 1] === " " ? 8 : 2;
      queryIndex++;
    }
  }
  return queryIndex === normalized.length ? score : 0;
}

export function filterSymbols(symbols: TuiSymbol[], query = "", limit = 40): TuiSymbol[] {
  return symbols
    .map((symbol, index) => ({ symbol, index, score: scoreSymbolMatch(symbol, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.symbol.path.localeCompare(b.symbol.path) || a.symbol.line - b.symbol.line || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.symbol);
}

export async function loadWorkspaceSymbols(input: {
  dir: string;
  query?: string;
  limit?: number;
  maxFiles?: number;
  files?: string[];
  commandRunner?: WorkspaceCommandRunner;
}): Promise<TuiSymbolResult> {
  const query = input.query?.trim() || "";
  const limit = input.limit || 40;
  const maxFiles = input.maxFiles || 1_500;

  try {
    const files = input.files || (await listWorkspaceFiles({
      dir: input.dir,
      limit: maxFiles,
      commandRunner: input.commandRunner,
    })).files;
    const sourceFiles = files.filter(isSourceFile).slice(0, maxFiles);
    const symbols = sourceFiles.flatMap((file) => loadFileSymbols(input.dir, file));

    return {
      query,
      symbols: filterSymbols(symbols, query, limit),
      scannedFiles: sourceFiles.length,
    };
  } catch (error) {
    return {
      query,
      symbols: [],
      scannedFiles: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function loadSymbolNavigation(input: {
  dir: string;
  query: string;
  files?: string[];
  commandRunner?: WorkspaceCommandRunner;
}): Promise<TuiSymbolNavigationResult> {
  const query = input.query.trim();
  if (!query) {
    return { query, scannedFiles: 0, message: "Usage: /goto <symbol>" };
  }

  const result = await loadWorkspaceSymbols({
    dir: input.dir,
    query,
    limit: 20,
    files: input.files,
    commandRunner: input.commandRunner,
  });
  if (result.error) {
    return { query, scannedFiles: result.scannedFiles, error: result.error, message: result.error };
  }

  const symbol = chooseNavigationSymbol(result.symbols, query);
  if (!symbol) {
    return {
      query,
      scannedFiles: result.scannedFiles,
      message: `No symbol matched ${query} across ${result.scannedFiles} files.`,
    };
  }

  const typeScriptNavigation = await loadTypeScriptDefinitionNavigation({
    dir: input.dir,
    query,
    symbol,
    files: input.files,
    commandRunner: input.commandRunner,
  });
  if (typeScriptNavigation) return typeScriptNavigation;

  return {
    query,
    scannedFiles: result.scannedFiles,
    symbol,
    source: navigationSourceForPath(symbol.path),
    message: navigationMessage(symbol),
  };
}

async function loadTypeScriptDefinitionNavigation(input: {
  dir: string;
  query: string;
  symbol: TuiSymbol;
  files?: string[];
  commandRunner?: WorkspaceCommandRunner;
  maxFiles?: number;
}): Promise<TuiSymbolNavigationResult | null> {
  if (!TYPESCRIPT_SOURCE_FILE_RE.test(input.symbol.path)) return null;
  if (!isIdentifierName(input.symbol.name)) return null;
  const ts = await import("typescript").catch(() => null);
  if (!ts) return null;

  try {
    const maxFiles = input.maxFiles || 1_500;
    const files = input.files || (await listWorkspaceFiles({
      dir: input.dir,
      limit: maxFiles,
      commandRunner: input.commandRunner,
    })).files;
    const tsFiles = files.filter((file) => TYPESCRIPT_SOURCE_FILE_RE.test(file)).slice(0, maxFiles);
    if (tsFiles.length === 0) return null;
    const service = createTypeScriptLanguageService(ts, input.dir, tsFiles.map((file) => join(input.dir, file)));
    const candidates = loadTypeScriptIdentifierCandidates(input.dir, tsFiles, input.symbol.name)
      .filter((occurrence) => !sameSymbolLocation(occurrence, input.symbol));

    for (const occurrence of candidates) {
      const absolute = join(input.dir, occurrence.path);
      const text = readFileSync(absolute, "utf8");
      const position = offsetFromLineColumn(text, occurrence.line, occurrence.column);
      const definitions = service.getDefinitionAtPosition(absolute, position) || [];
      const definition = definitions
        .map((info) => definitionInfoToSymbol(ts, service, input.dir, info, input.symbol.name))
        .find((candidate): candidate is TuiSymbol => Boolean(candidate));
      if (!definition) continue;
      return {
        query: input.query,
        scannedFiles: tsFiles.length,
        symbol: definition,
        source: "typescript",
        message: `TypeScript definition ${definition.name} ${definition.kind} at ${definition.path}:${definition.line}:${definition.column}`,
      };
    }
  } catch {
    return null;
  }

  return null;
}

export async function loadRenamePreview(input: {
  dir: string;
  oldName: string;
  newName: string;
  files?: string[];
  commandRunner?: WorkspaceCommandRunner;
  maxFiles?: number;
  maxOccurrences?: number;
}): Promise<TuiRenamePreviewResult> {
  const oldName = input.oldName.trim();
  const newName = input.newName.trim();
  const maxFiles = input.maxFiles || 1_500;
  const maxOccurrences = input.maxOccurrences || 80;

  if (!oldName || !newName) {
    return {
      oldName,
      newName,
      scannedFiles: 0,
      occurrences: [],
      message: "Usage: /rename-preview <symbol> <new-name>",
    };
  }
  if (!isIdentifierName(newName)) {
    return {
      oldName,
      newName,
      scannedFiles: 0,
      occurrences: [],
      message: `Invalid new symbol name: ${newName}`,
    };
  }

  const navigation = await loadSymbolNavigation({
    dir: input.dir,
    query: oldName,
    files: input.files,
    commandRunner: input.commandRunner,
  });
  if (!navigation.symbol) {
    return {
      oldName,
      newName,
      scannedFiles: navigation.scannedFiles,
      occurrences: [],
      error: navigation.error,
      message: navigation.message,
    };
  }
  if (!isIdentifierNameForSource(navigation.symbol.path, newName)) {
    return {
      oldName: navigation.symbol.name,
      newName,
      scannedFiles: navigation.scannedFiles,
      occurrences: [],
      symbol: navigation.symbol,
      message: `Invalid ${sourceLanguageLabel(navigation.symbol.path)} symbol name: ${newName}`,
    };
  }

  try {
    const files = input.files || (await listWorkspaceFiles({
      dir: input.dir,
      limit: maxFiles,
      commandRunner: input.commandRunner,
    })).files;
    const sourceFiles = files.filter(isSourceFile).slice(0, maxFiles);
    const typeScriptPreview = await loadTypeScriptRenamePreview({
      dir: input.dir,
      files: sourceFiles,
      symbol: navigation.symbol,
      newName,
      maxOccurrences,
    });
    if (typeScriptPreview) return typeScriptPreview;

    const pythonPreview = loadPythonRenamePreview({
      dir: input.dir,
      files: sourceFiles,
      symbol: navigation.symbol,
      newName,
      maxOccurrences,
    });
    if (pythonPreview) return pythonPreview;

    const goPreview = loadGoRenamePreview({
      dir: input.dir,
      files: sourceFiles,
      symbol: navigation.symbol,
      newName,
      maxOccurrences,
    });
    if (goPreview) return goPreview;

    const rustPreview = loadRustRenamePreview({
      dir: input.dir,
      files: sourceFiles,
      symbol: navigation.symbol,
      newName,
      maxOccurrences,
    });
    if (rustPreview) return rustPreview;

    const occurrences: TuiRenameOccurrence[] = [];

    for (const file of sourceFiles) {
      occurrences.push(...loadIdentifierOccurrences(input.dir, file, navigation.symbol.name, maxOccurrences - occurrences.length));
      if (occurrences.length >= maxOccurrences) break;
    }

    return {
      oldName: navigation.symbol.name,
      newName,
      scannedFiles: sourceFiles.length,
      occurrences,
      symbol: navigation.symbol,
      source: "scan",
      message: `Rename preview ${navigation.symbol.name} -> ${newName}: ${occurrences.length} occurrence${occurrences.length === 1 ? "" : "s"} across ${sourceFiles.length} files.`,
    };
  } catch (error) {
    return {
      oldName,
      newName,
      scannedFiles: navigation.scannedFiles,
      occurrences: [],
      symbol: navigation.symbol,
      error: error instanceof Error ? error.message : String(error),
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function applyRename(input: {
  dir: string;
  oldName: string;
  newName: string;
  files?: string[];
  commandRunner?: WorkspaceCommandRunner;
  maxFiles?: number;
  maxOccurrences?: number;
}): Promise<TuiRenameApplyResult> {
  const preview = await loadRenamePreview(input);
  if (preview.error || !preview.symbol) {
    return {
      ...preview,
      changedFiles: [],
      fileChanges: [],
      error: preview.error,
      message: preview.message,
    };
  }
  if (preview.occurrences.length === 0) {
    return {
      ...preview,
      changedFiles: [],
      fileChanges: [],
      message: `No occurrences to rename for ${preview.oldName}.`,
    };
  }

  try {
    const fileTexts = new Map<string, string>();
    const editsByPath = new Map<string, Array<{ offset: number; occurrence: TuiRenameOccurrence }>>();
    const seen = new Set<string>();

    for (const occurrence of preview.occurrences) {
      const absolute = join(input.dir, occurrence.path);
      const text = fileTexts.get(occurrence.path) ?? readFileSync(absolute, "utf8");
      fileTexts.set(occurrence.path, text);
      const offset = offsetFromLineColumn(text, occurrence.line, occurrence.column);
      const current = text.slice(offset, offset + preview.oldName.length);
      if (current !== preview.oldName) {
        return {
          ...preview,
          changedFiles: [],
          fileChanges: [],
          error: `Rename validation failed at ${occurrence.path}:${occurrence.line}:${occurrence.column}; expected ${preview.oldName}, found ${current || "EOF"}.`,
          message: `Rename validation failed at ${occurrence.path}:${occurrence.line}:${occurrence.column}; files were not changed.`,
        };
      }

      const key = `${occurrence.path}:${offset}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const edits = editsByPath.get(occurrence.path) || [];
      edits.push({ offset, occurrence });
      editsByPath.set(occurrence.path, edits);
    }

    const changedFiles: string[] = [];
    const fileChanges: TuiFileUndoChange[] = [];
    const appliedOccurrences: TuiRenameOccurrence[] = [];
    for (const [path, edits] of editsByPath.entries()) {
      const original = fileTexts.get(path);
      if (original === undefined) continue;
      let next = original;
      for (const edit of edits.sort((a, b) => b.offset - a.offset)) {
        next = `${next.slice(0, edit.offset)}${preview.newName}${next.slice(edit.offset + preview.oldName.length)}`;
        appliedOccurrences.push(edit.occurrence);
      }
      if (next !== original) {
        writeFileSync(join(input.dir, path), next, "utf8");
        changedFiles.push(path);
        fileChanges.push({ path, before: original, after: next });
      }
    }

    appliedOccurrences.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column);
    return {
      ...preview,
      occurrences: appliedOccurrences,
      changedFiles,
      fileChanges,
      message: `Renamed ${preview.oldName} -> ${preview.newName}: ${appliedOccurrences.length} occurrence${appliedOccurrences.length === 1 ? "" : "s"} across ${changedFiles.length} file${changedFiles.length === 1 ? "" : "s"}.`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...preview,
      changedFiles: [],
      fileChanges: [],
      error: message,
      message,
    };
  }
}

async function loadTypeScriptRenamePreview(input: {
  dir: string;
  files: string[];
  symbol: TuiSymbol;
  newName: string;
  maxOccurrences: number;
}): Promise<TuiRenamePreviewResult | null> {
  if (!TYPESCRIPT_SOURCE_FILE_RE.test(input.symbol.path)) return null;
  const ts = await import("typescript").catch(() => null);
  if (!ts) return null;

  try {
    const tsFiles = input.files.filter((file) => TYPESCRIPT_SOURCE_FILE_RE.test(file));
    if (tsFiles.length === 0) return null;
    const absoluteFiles = tsFiles.map((file) => join(input.dir, file));
    const targetFile = join(input.dir, input.symbol.path);
    const targetText = readFileSync(targetFile, "utf8");
    const position = offsetFromLineColumn(targetText, input.symbol.line, input.symbol.column);
    const service = createTypeScriptLanguageService(ts, input.dir, absoluteFiles);
    const renameInfo = service.getRenameInfo(targetFile, position);
    if (!renameInfo.canRename) return null;

    const locations = service.findRenameLocations(targetFile, position, false, false, true) || [];
    const occurrences = locations
      .slice(0, input.maxOccurrences)
      .map((location) => renameLocationToOccurrence(ts, service, input.dir, location))
      .filter((occurrence): occurrence is TuiRenameOccurrence => Boolean(occurrence));

    return {
      oldName: renameInfo.displayName || input.symbol.name,
      newName: input.newName,
      scannedFiles: tsFiles.length,
      occurrences,
      symbol: input.symbol,
      source: "typescript",
      message: `TypeScript rename preview ${renameInfo.displayName || input.symbol.name} -> ${input.newName}: ${occurrences.length} occurrence${occurrences.length === 1 ? "" : "s"} across ${tsFiles.length} files.`,
    };
  } catch {
    return null;
  }
}

function loadPythonRenamePreview(input: {
  dir: string;
  files: string[];
  symbol: TuiSymbol;
  newName: string;
  maxOccurrences: number;
}): TuiRenamePreviewResult | null {
  if (!PYTHON_SOURCE_FILE_RE.test(input.symbol.path)) return null;
  const pythonFiles = input.files.filter((file) => PYTHON_SOURCE_FILE_RE.test(file));
  if (pythonFiles.length === 0) return null;

  const occurrences: TuiRenameOccurrence[] = [];
  for (const file of pythonFiles) {
    occurrences.push(...loadPythonIdentifierOccurrences(
      input.dir,
      file,
      input.symbol.name,
      input.maxOccurrences - occurrences.length,
    ));
    if (occurrences.length >= input.maxOccurrences) break;
  }

  return {
    oldName: input.symbol.name,
    newName: input.newName,
    scannedFiles: pythonFiles.length,
    occurrences,
    symbol: input.symbol,
    source: "python",
    message: `Python rename preview ${input.symbol.name} -> ${input.newName}: ${occurrences.length} occurrence${occurrences.length === 1 ? "" : "s"} across ${pythonFiles.length} files.`,
  };
}

function loadGoRenamePreview(input: {
  dir: string;
  files: string[];
  symbol: TuiSymbol;
  newName: string;
  maxOccurrences: number;
}): TuiRenamePreviewResult | null {
  if (!GO_SOURCE_FILE_RE.test(input.symbol.path)) return null;
  const goFiles = input.files.filter((file) => GO_SOURCE_FILE_RE.test(file));
  if (goFiles.length === 0) return null;

  const occurrences: TuiRenameOccurrence[] = [];
  for (const file of goFiles) {
    occurrences.push(...loadMaskedIdentifierOccurrences(
      input.dir,
      file,
      input.symbol.name,
      input.maxOccurrences - occurrences.length,
      goCodeMask,
    ));
    if (occurrences.length >= input.maxOccurrences) break;
  }

  return {
    oldName: input.symbol.name,
    newName: input.newName,
    scannedFiles: goFiles.length,
    occurrences,
    symbol: input.symbol,
    source: "go",
    message: `Go rename preview ${input.symbol.name} -> ${input.newName}: ${occurrences.length} occurrence${occurrences.length === 1 ? "" : "s"} across ${goFiles.length} files.`,
  };
}

function loadRustRenamePreview(input: {
  dir: string;
  files: string[];
  symbol: TuiSymbol;
  newName: string;
  maxOccurrences: number;
}): TuiRenamePreviewResult | null {
  if (!RUST_SOURCE_FILE_RE.test(input.symbol.path)) return null;
  const rustFiles = input.files.filter((file) => RUST_SOURCE_FILE_RE.test(file));
  if (rustFiles.length === 0) return null;

  const occurrences: TuiRenameOccurrence[] = [];
  for (const file of rustFiles) {
    occurrences.push(...loadMaskedIdentifierOccurrences(
      input.dir,
      file,
      input.symbol.name,
      input.maxOccurrences - occurrences.length,
      rustCodeMask,
    ));
    if (occurrences.length >= input.maxOccurrences) break;
  }

  return {
    oldName: input.symbol.name,
    newName: input.newName,
    scannedFiles: rustFiles.length,
    occurrences,
    symbol: input.symbol,
    source: "rust",
    message: `Rust rename preview ${input.symbol.name} -> ${input.newName}: ${occurrences.length} occurrence${occurrences.length === 1 ? "" : "s"} across ${rustFiles.length} files.`,
  };
}

function createTypeScriptLanguageService(
  ts: typeof import("typescript"),
  dir: string,
  files: string[],
): import("typescript").LanguageService {
  const versions = new Map(files.map((file) => [file, "0"]));
  const options: import("typescript").CompilerOptions = {
    allowJs: true,
    checkJs: false,
    jsx: ts.JsxEmit.Preserve,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    noEmit: true,
    target: ts.ScriptTarget.ESNext,
  };

  const host: import("typescript").LanguageServiceHost = {
    getCompilationSettings: () => options,
    getCurrentDirectory: () => dir,
    getDefaultLibFileName: (compilerOptions) => ts.getDefaultLibFilePath(compilerOptions),
    getScriptFileNames: () => files,
    getScriptVersion: (fileName) => versions.get(fileName) || "0",
    getScriptSnapshot: (fileName) => {
      if (!ts.sys.fileExists(fileName)) return undefined;
      return ts.ScriptSnapshot.fromString(ts.sys.readFile(fileName) || "");
    },
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
  };
  return ts.createLanguageService(host, ts.createDocumentRegistry());
}

function renameLocationToOccurrence(
  ts: typeof import("typescript"),
  service: import("typescript").LanguageService,
  dir: string,
  location: import("typescript").RenameLocation,
): TuiRenameOccurrence | null {
  const program = service.getProgram();
  const sourceFile = program?.getSourceFile(location.fileName);
  if (!sourceFile) return null;
  const position = ts.getLineAndCharacterOfPosition(sourceFile, location.textSpan.start);
  const lineText = sourceFile.text.split(/\r?\n/)[position.line] || "";
  return {
    path: workspaceRelativePath(dir, location.fileName),
    line: position.line + 1,
    column: position.character + 1,
    text: lineText.trim(),
  };
}

function definitionInfoToSymbol(
  ts: typeof import("typescript"),
  service: import("typescript").LanguageService,
  dir: string,
  definition: import("typescript").DefinitionInfo,
  fallbackName: string,
): TuiSymbol | null {
  const program = service.getProgram();
  const sourceFile = program?.getSourceFile(definition.fileName);
  if (!sourceFile) return null;
  const position = ts.getLineAndCharacterOfPosition(sourceFile, definition.textSpan.start);
  const lineText = sourceFile.text.split(/\r?\n/)[position.line] || "";
  return {
    name: definition.name || fallbackName,
    kind: symbolKindFromScriptElementKind(definition.kind),
    path: workspaceRelativePath(dir, definition.fileName),
    line: position.line + 1,
    column: position.character + 1,
    signature: lineText.trim(),
  };
}

function loadTypeScriptIdentifierCandidates(
  dir: string,
  files: string[],
  identifier: string,
): TuiRenameOccurrence[] {
  return files.flatMap((file) => loadIdentifierOccurrences(dir, file, identifier, Number.POSITIVE_INFINITY));
}

function sameSymbolLocation(occurrence: TuiRenameOccurrence, symbol: TuiSymbol): boolean {
  return occurrence.path === symbol.path && occurrence.line === symbol.line && occurrence.column === symbol.column;
}

function symbolKindFromScriptElementKind(kind: string): TuiSymbolKind {
  if (kind.includes("class")) return "class";
  if (kind.includes("interface")) return "interface";
  if (kind.includes("enum")) return "enum";
  if (kind.includes("type")) return "type";
  if (kind.includes("method") || kind.includes("memberFunction")) return "method";
  if (kind.includes("function")) return "function";
  return "const";
}

function offsetFromLineColumn(text: string, line: number, column: number): number {
  const lines = text.split(/\r?\n/);
  let offset = 0;
  for (let index = 0; index < Math.max(0, line - 1); index++) {
    offset += (lines[index] || "").length + 1;
  }
  return offset + Math.max(0, column - 1);
}

function loadFileSymbols(dir: string, path: string): TuiSymbol[] {
  try {
    const absolute = join(dir, path);
    const stat = statSync(absolute);
    if (!stat.isFile() || stat.size > 1024 * 1024) return [];
    return parseSymbolsFromText(path, readFileSync(absolute, "utf8"));
  } catch {
    return [];
  }
}

function chooseNavigationSymbol(symbols: TuiSymbol[], query: string): TuiSymbol | undefined {
  const normalized = query.trim().toLowerCase();
  return symbols.find((symbol) => symbol.name.toLowerCase() === normalized) || symbols[0];
}

function navigationSourceForPath(path: string): TuiSymbolNavigationResult["source"] {
  if (PYTHON_SOURCE_FILE_RE.test(path)) return "python";
  if (GO_SOURCE_FILE_RE.test(path)) return "go";
  if (RUST_SOURCE_FILE_RE.test(path)) return "rust";
  return "scan";
}

function navigationSourceLabel(path: string): string {
  if (PYTHON_SOURCE_FILE_RE.test(path)) return "Python symbol";
  if (GO_SOURCE_FILE_RE.test(path)) return "Go symbol";
  if (RUST_SOURCE_FILE_RE.test(path)) return "Rust symbol";
  return "";
}

function navigationMessage(symbol: TuiSymbol): string {
  const prefix = navigationSourceLabel(symbol.path);
  const location = `${symbol.name} ${symbol.kind} at ${symbol.path}:${symbol.line}:${symbol.column}`;
  return prefix ? `${prefix} ${location}` : location;
}

function isIdentifierName(value: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(value);
}

function isIdentifierNameForSource(path: string, value: string): boolean {
  if (PYTHON_SOURCE_FILE_RE.test(path) || GO_SOURCE_FILE_RE.test(path) || RUST_SOURCE_FILE_RE.test(path)) {
    return /^[A-Za-z_]\w*$/.test(value);
  }
  return isIdentifierName(value);
}

function sourceLanguageLabel(path: string): string {
  if (PYTHON_SOURCE_FILE_RE.test(path)) return "Python";
  if (GO_SOURCE_FILE_RE.test(path)) return "Go";
  if (RUST_SOURCE_FILE_RE.test(path)) return "Rust";
  return "source";
}

function loadIdentifierOccurrences(
  dir: string,
  path: string,
  identifier: string,
  limit: number,
): TuiRenameOccurrence[] {
  if (TYPESCRIPT_SOURCE_FILE_RE.test(path)) {
    return loadMaskedIdentifierOccurrences(dir, path, identifier, limit, javaScriptCodeMask);
  }
  if (GO_SOURCE_FILE_RE.test(path)) {
    return loadMaskedIdentifierOccurrences(dir, path, identifier, limit, goCodeMask);
  }
  if (RUST_SOURCE_FILE_RE.test(path)) {
    return loadMaskedIdentifierOccurrences(dir, path, identifier, limit, rustCodeMask);
  }
  if (limit <= 0) return [];
  try {
    const absolute = join(dir, path);
    const stat = statSync(absolute);
    if (!stat.isFile() || stat.size > 1024 * 1024) return [];
    const occurrences: TuiRenameOccurrence[] = [];
    const lines = readFileSync(absolute, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      if (occurrences.length >= limit) return;
      for (const column of identifierColumns(line, identifier)) {
        occurrences.push({
          path,
          line: index + 1,
          column,
          text: line.trim(),
        });
        if (occurrences.length >= limit) return;
      }
    });
    return occurrences;
  } catch {
    return [];
  }
}

function loadPythonIdentifierOccurrences(
  dir: string,
  path: string,
  identifier: string,
  limit: number,
): TuiRenameOccurrence[] {
  if (limit <= 0) return [];
  try {
    const absolute = join(dir, path);
    const stat = statSync(absolute);
    if (!stat.isFile() || stat.size > 1024 * 1024) return [];
    const occurrences: TuiRenameOccurrence[] = [];
    const lines = readFileSync(absolute, "utf8").split(/\r?\n/);
    let inTripleQuote: string | null = null;

    lines.forEach((line, index) => {
      if (occurrences.length >= limit) return;
      const codeMask = pythonCodeMask(line, inTripleQuote);
      inTripleQuote = codeMask.inTripleQuote;
      for (const column of identifierColumns(codeMask.code, identifier)) {
        occurrences.push({
          path,
          line: index + 1,
          column,
          text: line.trim(),
        });
        if (occurrences.length >= limit) return;
      }
    });
    return occurrences;
  } catch {
    return [];
  }
}

type LineMaskState =
  | { kind: "block-comment" }
  | { kind: "raw-string"; terminator: string }
  | null;

function loadMaskedIdentifierOccurrences(
  dir: string,
  path: string,
  identifier: string,
  limit: number,
  maskLine: (line: string, state: LineMaskState) => { code: string; state: LineMaskState },
): TuiRenameOccurrence[] {
  if (limit <= 0) return [];
  try {
    const absolute = join(dir, path);
    const stat = statSync(absolute);
    if (!stat.isFile() || stat.size > 1024 * 1024) return [];
    const occurrences: TuiRenameOccurrence[] = [];
    const lines = readFileSync(absolute, "utf8").split(/\r?\n/);
    let state: LineMaskState = null;

    lines.forEach((line, index) => {
      if (occurrences.length >= limit) return;
      const masked = maskLine(line, state);
      state = masked.state;
      for (const column of identifierColumns(masked.code, identifier)) {
        occurrences.push({
          path,
          line: index + 1,
          column,
          text: line.trim(),
        });
        if (occurrences.length >= limit) return;
      }
    });
    return occurrences;
  } catch {
    return [];
  }
}

function pythonCodeMask(
  line: string,
  initialTripleQuote: string | null,
): { code: string; inTripleQuote: string | null } {
  let code = "";
  let index = 0;
  let inTripleQuote = initialTripleQuote;
  while (index < line.length) {
    if (inTripleQuote) {
      const end = line.indexOf(inTripleQuote, index);
      if (end === -1) {
        code += " ".repeat(line.length - index);
        return { code, inTripleQuote };
      }
      code += " ".repeat(end + inTripleQuote.length - index);
      index = end + inTripleQuote.length;
      inTripleQuote = null;
      continue;
    }

    const triple = line.startsWith('"""', index) ? '"""' : line.startsWith("'''", index) ? "'''" : null;
    if (triple) {
      const end = line.indexOf(triple, index + triple.length);
      if (end === -1) {
        code += " ".repeat(line.length - index);
        inTripleQuote = triple;
        return { code, inTripleQuote };
      }
      code += " ".repeat(end + triple.length - index);
      index = end + triple.length;
      continue;
    }

    const char = line[index];
    if (char === "#") {
      code += " ".repeat(line.length - index);
      break;
    }

    if (char === '"' || char === "'") {
      const end = findPythonStringEnd(line, index, char);
      code += " ".repeat(end - index);
      index = end;
      continue;
    }

    code += char;
    index++;
  }
  return { code, inTripleQuote };
}

function findPythonStringEnd(line: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < line.length) {
    if (line[index] === "\\") {
      index += 2;
      continue;
    }
    if (line[index] === quote) return index + 1;
    index++;
  }
  return line.length;
}

function javaScriptCodeMask(line: string, initialState: LineMaskState): { code: string; state: LineMaskState } {
  let code = "";
  let index = 0;
  let state = initialState;

  while (index < line.length) {
    if (state?.kind === "block-comment") {
      const end = line.indexOf("*/", index);
      if (end === -1) {
        code += " ".repeat(line.length - index);
        return { code, state };
      }
      code += " ".repeat(end + 2 - index);
      index = end + 2;
      state = null;
      continue;
    }

    if (state?.kind === "raw-string") {
      const end = findTemplateStringEnd(line, index);
      if (end === -1) {
        code += " ".repeat(line.length - index);
        return { code, state };
      }
      code += " ".repeat(end - index);
      index = end;
      state = null;
      continue;
    }

    if (line.startsWith("//", index)) {
      code += " ".repeat(line.length - index);
      break;
    }
    if (line.startsWith("/*", index)) {
      const end = line.indexOf("*/", index + 2);
      if (end === -1) {
        code += " ".repeat(line.length - index);
        state = { kind: "block-comment" };
        return { code, state };
      }
      code += " ".repeat(end + 2 - index);
      index = end + 2;
      continue;
    }

    const char = line[index];
    if (char === "`") {
      const end = findTemplateStringEnd(line, index + 1);
      if (end === -1) {
        code += " ".repeat(line.length - index);
        state = { kind: "raw-string", terminator: "`" };
        return { code, state };
      }
      code += " ".repeat(end - index);
      index = end;
      continue;
    }
    if (char === '"' || char === "'") {
      const end = findEscapedLiteralEnd(line, index, char);
      code += " ".repeat(end - index);
      index = end;
      continue;
    }

    code += char;
    index++;
  }

  return { code, state };
}

function goCodeMask(line: string, initialState: LineMaskState): { code: string; state: LineMaskState } {
  let code = "";
  let index = 0;
  let state = initialState;

  while (index < line.length) {
    if (state?.kind === "block-comment") {
      const end = line.indexOf("*/", index);
      if (end === -1) {
        code += " ".repeat(line.length - index);
        return { code, state };
      }
      code += " ".repeat(end + 2 - index);
      index = end + 2;
      state = null;
      continue;
    }

    if (state?.kind === "raw-string") {
      const end = line.indexOf(state.terminator, index);
      if (end === -1) {
        code += " ".repeat(line.length - index);
        return { code, state };
      }
      code += " ".repeat(end + state.terminator.length - index);
      index = end + state.terminator.length;
      state = null;
      continue;
    }

    if (line.startsWith("//", index)) {
      code += " ".repeat(line.length - index);
      break;
    }
    if (line.startsWith("/*", index)) {
      const end = line.indexOf("*/", index + 2);
      if (end === -1) {
        code += " ".repeat(line.length - index);
        state = { kind: "block-comment" };
        return { code, state };
      }
      code += " ".repeat(end + 2 - index);
      index = end + 2;
      continue;
    }

    const char = line[index];
    if (char === "`") {
      const end = line.indexOf("`", index + 1);
      if (end === -1) {
        code += " ".repeat(line.length - index);
        state = { kind: "raw-string", terminator: "`" };
        return { code, state };
      }
      code += " ".repeat(end + 1 - index);
      index = end + 1;
      continue;
    }
    if (char === '"' || char === "'") {
      const end = findEscapedLiteralEnd(line, index, char);
      code += " ".repeat(end - index);
      index = end;
      continue;
    }

    code += char;
    index++;
  }

  return { code, state };
}

function rustCodeMask(line: string, initialState: LineMaskState): { code: string; state: LineMaskState } {
  let code = "";
  let index = 0;
  let state = initialState;

  while (index < line.length) {
    if (state?.kind === "block-comment") {
      const end = line.indexOf("*/", index);
      if (end === -1) {
        code += " ".repeat(line.length - index);
        return { code, state };
      }
      code += " ".repeat(end + 2 - index);
      index = end + 2;
      state = null;
      continue;
    }

    if (state?.kind === "raw-string") {
      const end = line.indexOf(state.terminator, index);
      if (end === -1) {
        code += " ".repeat(line.length - index);
        return { code, state };
      }
      code += " ".repeat(end + state.terminator.length - index);
      index = end + state.terminator.length;
      state = null;
      continue;
    }

    if (line.startsWith("//", index)) {
      code += " ".repeat(line.length - index);
      break;
    }
    if (line.startsWith("/*", index)) {
      const end = line.indexOf("*/", index + 2);
      if (end === -1) {
        code += " ".repeat(line.length - index);
        state = { kind: "block-comment" };
        return { code, state };
      }
      code += " ".repeat(end + 2 - index);
      index = end + 2;
      continue;
    }

    const rawTerminator = rustRawStringTerminator(line, index);
    if (rawTerminator) {
      const literalStart = index;
      const contentStart = index + rawTerminator.prefixLength;
      const end = line.indexOf(rawTerminator.terminator, contentStart);
      if (end === -1) {
        code += " ".repeat(line.length - literalStart);
        state = { kind: "raw-string", terminator: rawTerminator.terminator };
        return { code, state };
      }
      code += " ".repeat(end + rawTerminator.terminator.length - literalStart);
      index = end + rawTerminator.terminator.length;
      continue;
    }

    const char = line[index];
    if (char === '"') {
      const end = findEscapedLiteralEnd(line, index, char);
      code += " ".repeat(end - index);
      index = end;
      continue;
    }
    if (char === "'" && isRustCharLiteralStart(line, index)) {
      const end = findEscapedLiteralEnd(line, index, char);
      code += " ".repeat(end - index);
      index = end;
      continue;
    }

    code += char;
    index++;
  }

  return { code, state };
}

function rustRawStringTerminator(
  line: string,
  start: number,
): { prefixLength: number; terminator: string } | null {
  if (line[start] !== "r") return null;
  let index = start + 1;
  while (line[index] === "#") index++;
  if (line[index] !== '"') return null;
  const hashes = index - start - 1;
  return {
    prefixLength: hashes + 2,
    terminator: `"${"#".repeat(hashes)}`,
  };
}

function isRustCharLiteralStart(line: string, start: number): boolean {
  if (line[start] !== "'") return false;
  if (line[start + 1] === "\\") {
    return line.indexOf("'", start + 2) !== -1;
  }
  return line[start + 1] !== undefined && line[start + 2] === "'";
}

function findTemplateStringEnd(line: string, start: number): number {
  let index = start;
  while (index < line.length) {
    if (line[index] === "\\") {
      index += 2;
      continue;
    }
    if (line[index] === "`") return index + 1;
    index++;
  }
  return -1;
}

function findEscapedLiteralEnd(line: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < line.length) {
    if (line[index] === "\\") {
      index += 2;
      continue;
    }
    if (line[index] === quote) return index + 1;
    index++;
  }
  return line.length;
}

function identifierColumns(line: string, identifier: string): number[] {
  const columns: number[] = [];
  let index = line.indexOf(identifier);
  while (index !== -1) {
    const before = index > 0 ? line[index - 1] : "";
    const after = line[index + identifier.length] || "";
    if (!isIdentifierChar(before) && !isIdentifierChar(after)) {
      columns.push(index + 1);
    }
    index = line.indexOf(identifier, index + identifier.length);
  }
  return columns;
}

function isIdentifierChar(char: string): boolean {
  return /^[A-Za-z0-9_$]$/.test(char);
}
