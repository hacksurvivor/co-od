import type { KeyInfo } from "./tui-actions.js";

export interface TuiConfirmation {
  id: string;
  title: string;
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

export type ConfirmationKeyIntent =
  | { type: "none" }
  | { type: "confirm" }
  | { type: "cancel" };

export function createConfirmation(input: TuiConfirmation): TuiConfirmation {
  return {
    ...input,
    confirmLabel: input.confirmLabel || "Confirm",
    cancelLabel: input.cancelLabel || "Cancel",
  };
}

export function resolveConfirmationKey(chunk: string, key: KeyInfo): ConfirmationKeyIntent {
  const name = key.name || "";
  if (name === "return" || chunk.toLowerCase() === "y") return { type: "confirm" };
  if (name === "escape" || name === "q" || chunk.toLowerCase() === "n") return { type: "cancel" };
  return { type: "none" };
}
