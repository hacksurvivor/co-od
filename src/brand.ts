// co·ode brand tokens — single source of truth for the CLI + TUI. See BRAND.md.
// "Calm room, alive": monochrome, with ONE ember signature for life/presence.

export const BRAND = {
  /** The one accent. Life, presence, "now" — the brand dot, live indicator, an active agent/run. Nothing else. */
  ember: "#E8633A",
  /** Primary text. Soft bone, never pure white. */
  ink: "#C9D1D9",
  /** Secondary text, chrome labels, separators, idle. */
  muted: "#6E7681",
  /** Borders, dividers, rules. */
  faint: "#30363D",
  /** Conceptual near-black base. Referenced, not forced (honor terminal transparency). */
  ground: "#0E1116",
  /** Done. Calm green, never neon. */
  success: "#57A773",
  /** Needs attention. Muted amber, status only. */
  warning: "#D29922",
  /** Failed. */
  danger: "#E5534B",
} as const;

function truecolor(hex: string): (text: string) => string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return (text: string) => `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

/** ANSI truecolor wrappers for plain CLI output (login / setup gate). */
export const ember = truecolor(BRAND.ember);
export const ink = truecolor(BRAND.ink);
export const muted = truecolor(BRAND.muted);
export const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
export const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;

/** The wordmark, with the ember dot when live (the room is on) or muted when offline. */
export function wordmark(live = true): string {
  return `co${live ? ember("·") : muted("·")}ode`;
}

/** A calm one-line brand header for CLI surfaces, optionally with a muted subtitle. */
export function brandHeader(subtitle?: string): string {
  const head = `  ${bold(wordmark(true))}`;
  return subtitle ? `${head}\n  ${muted(subtitle)}` : head;
}
