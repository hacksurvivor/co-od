import { brandHeader, dim, ember, muted } from "./brand.js";

export function loginStartText(serverUrl: string): string {
  const serverLine = serverUrl === "https://co-od.dev" ? "" : `\n  ${muted(`server ${serverUrl}`)}`;
  return `${brandHeader("join your coding room")}${serverLine}\n`;
}

export function loginApprovalText(verificationUrl: string, code: string): string {
  return [
    "",
    `${ember("●")} browser opened`,
    "",
    "approve this device",
    `  ${verificationUrl}`,
    "",
    "code",
    `  ${code}`,
    "",
    dim("waiting for approval..."),
  ].join("\n");
}

export function loginManualApprovalText(verificationUrl: string, code: string): string {
  return [
    "",
    muted("browser could not open automatically"),
    "",
    "approve this device",
    `  ${verificationUrl}`,
    "",
    "code",
    `  ${code}`,
    "",
    dim("waiting for approval..."),
  ].join("\n");
}

export function loginSuccessText(displayName: string): string {
  return [
    "",
    `${muted("✓")} signed in as ${displayName}`,
    muted("room key saved"),
    "run  co-od tui",
  ].join("\n");
}

export function tokenLoginSuccessText(): string {
  return [
    brandHeader("session ready"),
    "",
    `${muted("✓")} token saved`,
    "run  co-od tui",
  ].join("\n");
}
