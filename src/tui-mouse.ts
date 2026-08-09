export interface TuiMouseEvent {
  button: number;
  column: number;
  row: number;
  released: boolean;
  type: "press" | "release" | "drag" | "scroll";
}

const SGR_MOUSE_PATTERN = /^\x1b\[<(\d+);(\d+);(\d+)([mM])$/;

export function parseSgrMouse(sequence: string): TuiMouseEvent | null {
  const match = SGR_MOUSE_PATTERN.exec(sequence);
  if (!match) return null;

  const button = Number(match[1]);
  const column = Number(match[2]);
  const row = Number(match[3]);
  const released = match[4] === "m";

  if (!Number.isFinite(button) || !Number.isFinite(column) || !Number.isFinite(row)) {
    return null;
  }

  const type =
    button >= 64 && button < 96
      ? "scroll"
      : released
        ? "release"
        : (button & 32) === 32
          ? "drag"
          : "press";

  return { button, column, row, released, type };
}

export function isPrimaryMousePress(event: TuiMouseEvent): boolean {
  return event.type === "press" && event.button === 0;
}
