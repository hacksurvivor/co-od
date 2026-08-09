import { ANSI_RESET } from "./tui-render.js";
import { BRAND } from "./brand.js";

export interface TuiTheme {
  name: string;
  colors: {
    foreground: string;
    muted: string;
    faint: string;
    ground: string;
    success: string;
    warning: string;
    danger: string;
    accent: string;
    selectionForeground: string;
    selectionBackground: string;
  };
}

export const HIGH_CONTRAST_TUI_THEME: TuiTheme = {
  name: "co-ode-brand",
  colors: {
    foreground: BRAND.ink,
    muted: BRAND.muted,
    faint: BRAND.faint,
    ground: BRAND.ground,
    success: BRAND.success,
    warning: BRAND.warning,
    danger: BRAND.danger,
    accent: BRAND.ember,
    selectionForeground: BRAND.ink,
    selectionBackground: BRAND.faint,
  },
};

export const tuiColor = {
  dim: (text: string) => `\x1b[2m${text}${ANSI_RESET}`,
  bold: (text: string) => `\x1b[1m${text}${ANSI_RESET}`,
  green: (text: string) => `\x1b[32m${text}${ANSI_RESET}`,
  yellow: (text: string) => `\x1b[33m${text}${ANSI_RESET}`,
  red: (text: string) => `\x1b[31m${text}${ANSI_RESET}`,
  cyan: (text: string) => `\x1b[36m${text}${ANSI_RESET}`,
  inverse: (text: string) => `\x1b[7m${text}${ANSI_RESET}`,
};

export function opentuiTextColor(theme: TuiTheme = HIGH_CONTRAST_TUI_THEME): string {
  return theme.colors.foreground;
}

export function themeColorFamilies(theme: TuiTheme = HIGH_CONTRAST_TUI_THEME): string[] {
  return [
    theme.colors.success,
    theme.colors.warning,
    theme.colors.danger,
    theme.colors.accent,
  ].map(colorFamily);
}

function colorFamily(hex: string): string {
  const normalized = hex.replace("#", "");
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  const max = Math.max(red, green, blue);
  if (red > 120 && green > 100 && blue < Math.min(red, green) * 0.7) return "yellow";
  if (max === red) return "red";
  if (max === green) return "green";
  return "blue";
}
