export const ANSI_RESET = "\x1b[0m";

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

export function visibleLength(text: string): number {
  return stripAnsi(text).length;
}

export function padAnsi(input: string, width: number): string {
  const padding = Math.max(0, width - visibleLength(input));
  return input + " ".repeat(padding);
}

export function fitAnsi(input: string, width: number): string {
  let output = "";
  let visible = 0;

  for (let i = 0; i < input.length; i++) {
    if (input[i] === "\x1b") {
      const match = input.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (match) {
        output += match[0];
        i += match[0].length - 1;
        continue;
      }
    }

    if (visible >= width) break;
    output += input[i];
    visible++;
  }

  if (output.includes("\x1b[") && !output.endsWith(ANSI_RESET)) {
    output += ANSI_RESET;
  }

  const padding = Math.max(0, width - visible);
  return output + " ".repeat(padding);
}

/**
 * Word-wrap plain text to a column width. Breaks on spaces; hard-breaks tokens
 * longer than the width (paths, URLs). Preserves leading indentation of the
 * source line on every wrapped continuation so structure stays readable.
 */
export function wrapPlain(text: string, width: number): string[] {
  const cols = Math.max(4, Math.floor(width));
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") {
      out.push("");
      continue;
    }
    // The line's lead (indent plus an optional list/tool marker) renders once;
    // wrapped continuations get matching spaces so structure stays aligned.
    const lead = raw.match(/^\s*(?:[›·•↳▸*+-]\s+|\d+\.\s+)?/)?.[0] || "";
    const hang = " ".repeat(Math.min(lead.length, Math.max(0, cols - 8)));
    let line = lead;
    let used = lead.length;
    let bare = true;
    for (let token of raw.slice(lead.length).split(/ +/)) {
      while (token.length > 0) {
        if (used + (bare ? 0 : 1) + token.length <= cols) {
          line += (bare ? "" : " ") + token;
          used += (bare ? 0 : 1) + token.length;
          bare = false;
          token = "";
        } else if (!bare) {
          out.push(line);
          line = hang;
          used = hang.length;
          bare = true;
        } else {
          const room = Math.max(1, cols - used);
          out.push(line + token.slice(0, room));
          token = token.slice(room);
          line = hang;
          used = hang.length;
          bare = true;
        }
      }
    }
    if (!bare || out.length === 0) out.push(line);
  }
  return out.length > 0 ? out : [""];
}

export function renderTerminalFrame(lines: string[], width: number, height: number): string {
  const fitted = lines.slice(0, height).map((line) => fitAnsi(line, width));
  while (fitted.length < height) fitted.push(" ".repeat(width));
  return fitted.join("\n");
}
