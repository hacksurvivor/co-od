import test from "node:test";
import assert from "node:assert/strict";

import {
  HIGH_CONTRAST_TUI_THEME,
  opentuiTextColor,
  themeColorFamilies,
  tuiColor,
} from "../dist/tui-theme.js";
import { BRAND } from "../dist/brand.js";
import { ANSI_RESET, stripAnsi } from "../dist/tui-render.js";

test("TUI theme exposes co·ode brand colors without collapsing to one hue", () => {
  assert.equal(HIGH_CONTRAST_TUI_THEME.name, "co-ode-brand");
  assert.equal(opentuiTextColor(), HIGH_CONTRAST_TUI_THEME.colors.foreground);
  assert.equal(HIGH_CONTRAST_TUI_THEME.colors.foreground, BRAND.ink);
  assert.equal(HIGH_CONTRAST_TUI_THEME.colors.muted, BRAND.muted);
  assert.equal(HIGH_CONTRAST_TUI_THEME.colors.faint, BRAND.faint);
  assert.equal(HIGH_CONTRAST_TUI_THEME.colors.ground, BRAND.ground);
  assert.equal(HIGH_CONTRAST_TUI_THEME.colors.accent, BRAND.ember);
  assert.equal(HIGH_CONTRAST_TUI_THEME.colors.success, BRAND.success);
  assert.equal(HIGH_CONTRAST_TUI_THEME.colors.warning, BRAND.warning);
  assert.equal(HIGH_CONTRAST_TUI_THEME.colors.danger, BRAND.danger);
  assert.equal(new Set(themeColorFamilies()).size >= 3, true);
});

test("tuiColor styles preserve text and terminate ANSI sequences", () => {
  const styled = tuiColor.green("ready");
  assert.equal(stripAnsi(styled), "ready");
  assert.equal(styled.endsWith(ANSI_RESET), true);
});
