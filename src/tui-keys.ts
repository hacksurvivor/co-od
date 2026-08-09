// Key-sequence normalization for terminals speaking the kitty keyboard
// protocol (CSI-u) or xterm modifyOtherKeys. OpenTUI's own widgets parse
// these natively, but the TUI host and reducer compare raw legacy bytes
// ("\r", "\x1b", "j", ""…) — so a terminal like Ghostty or Kitty that
// upgrades the keyboard protocol silently breaks every hotkey unless we
// translate at the input boundary.
//
// Returns the legacy byte string for the key, the original sequence when it
// isn't a CSI-u/modifyOtherKeys encoding, or "" for key-release events
// (which must be swallowed, not dispatched).

const CSI_U = /^\x1b\[(\d+)(?:;(\d+)(?::(\d+))?)?u$/;
const MODIFY_OTHER_KEYS = /^\x1b\[27;(\d+);(\d+)~$/;

export function normalizeKeySequence(sequence: string): string {
  let code: number;
  let mods = 1;
  let event = 1;

  const kitty = CSI_U.exec(sequence);
  if (kitty) {
    code = Number(kitty[1]);
    mods = Number(kitty[2] || "1");
    event = Number(kitty[3] || "1");
  } else {
    const xterm = MODIFY_OTHER_KEYS.exec(sequence);
    if (!xterm) return sequence;
    mods = Number(xterm[1]);
    code = Number(xterm[2]);
  }

  // Key release (kitty event type 3) — nothing should fire on release.
  if (event === 3) return "";

  const bits = Math.max(0, mods - 1);
  const shift = (bits & 1) !== 0;
  const alt = (bits & 2) !== 0;
  const ctrl = (bits & 4) !== 0;

  let base: string;
  switch (code) {
    case 13: base = "\r"; break;
    case 27: base = "\x1b"; break;
    case 9: base = "\t"; break;
    case 8:
    case 127: base = "\x7f"; break;
    default:
      if (code >= 32 && code <= 0x10ffff) {
        base = String.fromCodePoint(code);
      } else {
        return sequence;
      }
  }

  if (ctrl && base.length === 1) {
    // Ctrl+letter maps to its control byte (^B = ), like a legacy tty.
    const upper = base.toUpperCase().codePointAt(0)!;
    if (upper >= 0x40 && upper <= 0x5f) {
      base = String.fromCharCode(upper & 0x1f);
    } else if (base === " ") {
      base = "\x00";
    }
  } else if (shift && base.length === 1) {
    // Kitty reports the base layout key plus a shift modifier.
    base = base.toUpperCase();
  }

  return alt ? `\x1b${base}` : base;
}
