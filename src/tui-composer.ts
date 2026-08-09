import { fitAnsi } from "./tui-render.js";

// Zero-width sentinel that marks the cursor position while rows are laid
// out; swapped for the visible marker at the end. Kept out of literals so no
// raw NUL byte lands in the source (Bun mis-parses those).
const CURSOR_SENTINEL = String.fromCharCode(0);

export interface ComposerWindow {
  /** Visible rows, cursor marker already inserted. */
  lines: string[];
  /** Rows hidden above the window (cursor stays visible). */
  hiddenAbove: number;
  /** Rows hidden below the window. */
  hiddenBelow: number;
}

/**
 * Lay the composer input out as wrapped rows with the cursor marker inserted,
 * windowed so the cursor row is always visible. Newlines start new rows; rows
 * longer than the width soft-wrap. Pure — drives the chat composer rendering.
 */
export function composerWindow(
  input: string,
  cursor: number,
  width: number,
  maxLines: number,
  marker = "▏",
): ComposerWindow {
  const cols = Math.max(4, Math.floor(width));
  const max = Math.max(1, Math.floor(maxLines));
  const at = Math.min(Math.max(0, cursor), input.length);
  const withCursor = input.slice(0, at) + CURSOR_SENTINEL + input.slice(at);

  const rows: string[] = [];
  for (const logical of withCursor.split("\n")) {
    if (logical === "") {
      rows.push("");
      continue;
    }
    // The NUL cursor placeholder occupies no visible column.
    for (let start = 0; start < logical.length; ) {
      let take = 0;
      let visible = 0;
      while (start + take < logical.length && visible < cols) {
        if (logical[start + take] !== CURSOR_SENTINEL) visible++;
        take++;
      }
      // Don't strand the cursor placeholder at a row boundary.
      if (logical[start + take] === CURSOR_SENTINEL) take++;
      rows.push(logical.slice(start, start + take));
      start += take;
      if (start >= logical.length) break;
    }
    if (logical.length === 0) rows.push("");
  }

  const cursorRow = Math.max(0, rows.findIndex((row) => row.includes(CURSOR_SENTINEL)));
  let first = 0;
  if (rows.length > max) {
    first = Math.min(Math.max(0, cursorRow - max + 1), rows.length - max);
  }
  const visibleRows = rows.slice(first, first + max);
  return {
    lines: visibleRows.map((row) => row.split(CURSOR_SENTINEL).join(marker)),
    hiddenAbove: first,
    hiddenBelow: Math.max(0, rows.length - first - max),
  };
}

export interface TaskComposerLineOptions {
  width: number;
  cursor?: string;
  prompt?: string;
  continuationPrompt?: string;
  maxLines?: number;
}

export function taskComposerLines(input: string, options: TaskComposerLineOptions): string[] {
  const prompt = options.prompt ?? "> ";
  const continuationPrompt = options.continuationPrompt ?? "| ";
  const cursor = options.cursor ?? "";
  const width = Math.max(1, Math.floor(options.width));
  const rawLines = input.split("\n");
  const maxLines = options.maxLines && options.maxLines > 0
    ? Math.floor(options.maxLines)
    : rawLines.length;
  const hidden = Math.max(0, rawLines.length - maxLines);
  const visibleLines = hidden > 0 ? rawLines.slice(-maxLines) : rawLines;

  const lines = visibleLines.map((line, index) => {
    const sourceIndex = hidden + index;
    const marker = sourceIndex === 0 ? prompt : continuationPrompt;
    const suffix = index === visibleLines.length - 1 ? cursor : "";
    return fitAnsi(`${marker}${line}${suffix}`, width);
  });

  if (hidden > 0) {
    lines[0] = fitAnsi(`${continuationPrompt}... ${hidden} earlier line${hidden === 1 ? "" : "s"}`, width);
  }

  return lines.length > 0 ? lines : [fitAnsi(`${prompt}${cursor}`, width)];
}
