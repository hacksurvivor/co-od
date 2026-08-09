import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export type TuiAttachmentKind = "directory" | "file" | "image";

export interface TuiAttachment {
  path: string;
  kind?: TuiAttachmentKind;
}

export interface TuiAttachmentTransport {
  path: string;
  absolutePath: string;
  kind: TuiAttachmentKind;
  exists: boolean;
}

export interface ProviderAttachmentTransportSummary {
  provider: string;
  native: TuiAttachmentTransport[];
  fallback: TuiAttachmentTransport[];
  lines: string[];
}

export type AttachResult =
  | { ok: true; attachments: TuiAttachment[]; message: string }
  | { ok: false; attachments: TuiAttachment[]; message: string };

export interface AddAttachmentOptions {
  kind?: TuiAttachmentKind;
  projectDir?: string;
}

const IMAGE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".tif",
  ".tiff",
  ".webp",
]);

export function normalizeAttachmentPath(path: string): string {
  return path.trim().replace(/^["']|["']$/g, "");
}

export function inferAttachmentKind(path: string, projectDir?: string): TuiAttachmentKind {
  const normalized = normalizeAttachmentPath(path);
  const absolute = projectDir && normalized && !isAbsolute(normalized)
    ? join(projectDir, normalized)
    : normalized;

  try {
    if (absolute && existsSync(absolute) && statSync(absolute).isDirectory()) {
      return "directory";
    }
  } catch {
    // Fall back to extension inference below.
  }

  const lower = normalized.toLowerCase();
  const extension = lower.match(/\.[a-z0-9]+$/)?.[0];
  return extension && IMAGE_EXTENSIONS.has(extension) ? "image" : "file";
}

export function attachmentLabel(attachment: TuiAttachment): string {
  return `[${attachment.kind || inferAttachmentKind(attachment.path)}] ${attachment.path}`;
}

export function addAttachment(
  current: TuiAttachment[],
  path: string,
  options: AddAttachmentOptions = {},
): AttachResult {
  const normalized = normalizeAttachmentPath(path);
  if (!normalized) {
    return { ok: false, attachments: current, message: "Attach needs a file path." };
  }
  const kind = options.kind || inferAttachmentKind(normalized, options.projectDir);
  if (current.some((attachment) => attachment.path === normalized)) {
    return { ok: true, attachments: current, message: `Already attached: ${normalized}` };
  }
  return {
    ok: true,
    attachments: [...current, { path: normalized, kind }],
    message: `Attached ${kind}: ${normalized}`,
  };
}

export function removeAttachment(current: TuiAttachment[], target?: string): AttachResult {
  const normalized = normalizeAttachmentPath(target || "");
  if (!normalized) {
    return { ok: false, attachments: current, message: "Detach needs a path, index, or all." };
  }
  if (normalized.toLowerCase() === "all") {
    return { ok: true, attachments: [], message: "Cleared attachments." };
  }

  const index = Number(normalized);
  if (Number.isInteger(index) && index >= 1 && index <= current.length) {
    const removed = current[index - 1];
    return {
      ok: true,
      attachments: current.filter((_, attachmentIndex) => attachmentIndex !== index - 1),
      message: `Detached: ${removed.path}`,
    };
  }

  const next = current.filter((attachment) => attachment.path !== normalized);
  if (next.length === current.length) {
    return { ok: false, attachments: current, message: `Attachment not found: ${normalized}` };
  }
  return { ok: true, attachments: next, message: `Detached: ${normalized}` };
}

export function attachmentSummary(attachments: TuiAttachment[], limit = 6): string {
  if (attachments.length === 0) return "No attached files.";
  const visible = attachments.slice(0, limit).map((attachment, index) => `${index + 1}. ${attachmentLabel(attachment)}`);
  if (attachments.length > limit) {
    visible.push(`... ${attachments.length - limit} more`);
  }
  return visible.join("\n");
}

export function formatGoalWithAttachments(goal: string, attachments: TuiAttachment[]): string {
  const trimmed = goal.trim();
  if (attachments.length === 0) return trimmed;
  const files = attachments.filter((attachment) => (attachment.kind || inferAttachmentKind(attachment.path)) === "file");
  const directories = attachments.filter((attachment) => (attachment.kind || inferAttachmentKind(attachment.path)) === "directory");
  const images = attachments.filter((attachment) => (attachment.kind || inferAttachmentKind(attachment.path)) === "image");
  return [
    "Attached context:",
    ...formatAttachmentGroup("Files", files),
    ...formatAttachmentGroup("Directories", directories),
    ...formatAttachmentGroup("Images", images, "image path; inspect directly if your provider supports image inputs"),
    "",
    "Task:",
    trimmed,
  ].join("\n");
}

export function resolveAttachmentTransport(
  attachments: TuiAttachment[],
  projectDir: string,
): TuiAttachmentTransport[] {
  const seen = new Set<string>();
  const transports: TuiAttachmentTransport[] = [];

  for (const attachment of attachments) {
    const path = normalizeAttachmentPath(attachment.path);
    if (!path) continue;
    const absolutePath = isAbsolute(path) ? path : resolve(projectDir, path);
    if (seen.has(absolutePath)) continue;
    seen.add(absolutePath);

    transports.push({
      path,
      absolutePath,
      kind: attachment.kind || inferAttachmentKind(path, projectDir),
      exists: existsSync(absolutePath),
    });
  }

  return transports;
}

export function nativeAttachmentKindsForProvider(provider: string): TuiAttachmentKind[] {
  const normalized = provider.toLowerCase();
  if (normalized === "claude" || normalized === "anthropic") return ["directory"];
  if (normalized === "codex" || normalized === "openai") return ["directory", "image"];
  if (normalized === "opencode") return ["file", "image"];
  return [];
}

export function attachmentTransportSummary(
  attachments: TuiAttachment[],
  provider: string,
  projectDir: string,
): ProviderAttachmentTransportSummary {
  const transport = resolveAttachmentTransport(attachments, projectDir);
  const nativeKinds = new Set(nativeAttachmentKindsForProvider(provider));
  const native = transport.filter((attachment) => attachment.exists && nativeKinds.has(attachment.kind));
  const fallback = transport.filter((attachment) => !attachment.exists || !nativeKinds.has(attachment.kind));
  const providerName = provider || "provider";
  const lines = [`Provider transport for ${providerName}:`];

  if (transport.length === 0) {
    lines.push("native flags: none");
    lines.push("prompt/env fallback: none");
    return { provider: providerName, native, fallback, lines };
  }

  lines.push(`native flags: ${formatTransportList(native)}`);
  lines.push(`prompt/env fallback: ${formatTransportList(fallback)}`);
  lines.push("prompt context: included in submitted task text");
  return { provider: providerName, native, fallback, lines };
}

function formatAttachmentGroup(title: string, attachments: TuiAttachment[], note?: string): string[] {
  if (attachments.length === 0) return [];
  return [
    `${title}:`,
    ...attachments.map((attachment) => `- ${attachment.path}${note ? ` (${note})` : ""}`),
  ];
}

function formatTransportList(attachments: TuiAttachmentTransport[]): string {
  if (attachments.length === 0) return "none";
  return attachments
    .map((attachment) => `[${attachment.kind}] ${attachment.path}${attachment.exists ? "" : " (missing)"}`)
    .join(", ");
}
