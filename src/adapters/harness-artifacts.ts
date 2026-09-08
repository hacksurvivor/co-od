import { createHash } from "node:crypto";
import type {
  HarnessArtifactKind,
  HarnessArtifactUpdate,
} from "./base.js";

const MAX_ARTIFACT_TEXT_BYTES = 10 * 1_024 * 1_024;
const MAX_ARTIFACT_CONTEXT_BYTES = 8 * 1_024 * 1_024;
const sensitiveKey = /(?:api[_-]?key|authorization|cookie|credential|password|secret|token)/i;

type ArtifactOptions = {
  provider: string;
  server?: string;
  tool?: string;
  title?: string;
  uri?: string;
  context?: string;
  displayMode?: "inline" | "fullscreen";
  interactive?: boolean;
  forceKind?: HarnessArtifactKind;
};
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const boundedUTF8 = (value: unknown, maximum = MAX_ARTIFACT_TEXT_BYTES): string | undefined => {
  if (typeof value !== "string" || !value || value.includes("\0")) return undefined;
  const bytes = Buffer.from(value, "utf8");
  return bytes.length <= maximum ? value : undefined;
};

export const harnessArtifactContext = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  try {
    const serialized = JSON.stringify(value, (key, child) =>
      sensitiveKey.test(key) ? "[redacted]" : child);
    return Buffer.byteLength(serialized, "utf8") <= MAX_ARTIFACT_CONTEXT_BYTES
      ? serialized
      : undefined;
  } catch {
    return undefined;
  }
};

export const harnessArtifactKind = (mediaType: string): HarnessArtifactKind => {
  if (/^text\/html\s*;[^\r\n]*\bprofile\s*=\s*["']?mcp-app\b/i.test(mediaType.trim())) {
    return "mcpApp";
  }
  const normalized = mediaType.split(";", 1)[0].trim().toLowerCase();
  if (normalized === "text/html") return "html";
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("audio/")) return "audio";
  if (normalized.startsWith("video/")) return "video";
  if (normalized === "application/pdf") return "pdf";
  if (normalized === "application/json" || normalized === "text/csv") return "data";
  if (normalized.startsWith("text/")) return "text";
  return "unknown";
};

const extensionFor = (mediaType: string): string => {
  const normalized = mediaType.split(";", 1)[0].trim().toLowerCase();
  return ({
    "text/html": "html",
    "text/plain": "txt",
    "text/markdown": "md",
    "text/csv": "csv",
    "application/json": "json",
    "application/pdf": "pdf",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/wav": "wav",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
  } as Record<string, string>)[normalized] || "bin";
};

const safeStem = (value: unknown): string => {
  const normalized = String(value || "artifact")
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}._ -]+/gu, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 96);
  return normalized || "artifact";
};

const fileNameFor = (title: string, mediaType: string, uri?: string): string => {
  const fromURI = uri?.split(/[/?#]/).filter(Boolean).at(-1);
  const candidate = safeStem(fromURI || title);
  if (/\.[a-z0-9]{1,8}$/i.test(candidate)) return candidate.slice(0, 140);
  return `${candidate}.${extensionFor(mediaType)}`.slice(0, 140);
};

const artifactID = (
  options: ArtifactOptions,
  mediaType: string,
  content: string | undefined,
  index: number,
): string => createHash("sha256").update(JSON.stringify({
  provider: options.provider,
  server: options.server,
  tool: options.tool,
  uri: options.uri,
  mediaType,
  content,
  context: options.context,
  index,
})).digest("hex").slice(0, 32);

const titleFromResult = (result: Record<string, unknown> | undefined): string | undefined => {
  const structured = record(result?.structuredContent);
  const artifact = record(structured?.artifact) || record(record(result?._meta)?.artifact);
  for (const value of [artifact?.title, structured?.title, result?.title]) {
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 160);
  }
  return undefined;
};

export const harnessArtifactFromResource = (
  resourceValue: unknown,
  options: ArtifactOptions,
  index = 0,
): HarnessArtifactUpdate | undefined => {
  const resource = record(resourceValue);
  if (!resource) return undefined;
  const mediaType = typeof resource.mimeType === "string" && resource.mimeType.trim()
    ? resource.mimeType.trim().slice(0, 160)
    : "application/octet-stream";
  const uri = typeof resource.uri === "string" ? resource.uri.slice(0, 4_096) : options.uri;
  const title = safeStem(options.title || resource.title || resource.name || "Artifact");
  const text = boundedUTF8(resource.text);
  const blob = boundedUTF8(resource.blob);
  const content = text ?? blob;
  const encoding = text !== undefined ? "utf8" as const
    : blob !== undefined ? "base64" as const : undefined;
  const kind = options.forceKind || harnessArtifactKind(mediaType);
  let context = options.context;
  if (resource._meta) {
    try {
      context = harnessArtifactContext({ ...(context ? JSON.parse(context) : {}), resourceMeta: resource._meta });
    } catch { /* Invalid context remains unavailable. */ }
  }
  return {
    id: artifactID({ ...options, uri, context }, mediaType, content, index),
    kind,
    title,
    mediaType,
    fileName: fileNameFor(title, mediaType, uri),
    ...(uri ? { uri } : {}),
    ...(content !== undefined ? { content } : {}),
    ...(encoding ? { encoding } : {}),
    ...(context ? { context } : {}),
    ...(options.displayMode ? { displayMode: options.displayMode } : {}),
    ...(options.interactive !== undefined ? { interactive: options.interactive } : {}),
    provider: options.provider,
    ...(options.server ? { server: options.server } : {}),
    ...(options.tool ? { tool: options.tool } : {}),
  };
};

const resultEnvelope = (resultValue: unknown): Record<string, unknown> | undefined => {
  if (Array.isArray(resultValue)) return { content: resultValue };
  return record(resultValue);
};

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, 4_096) : undefined;

const mcpAppResourceURI = (result: Record<string, unknown>): string | undefined => {
  const meta = record(result._meta);
  const structuredMeta = record(record(result.structuredContent)?._meta);
  for (const candidate of [
    record(meta?.ui)?.resourceUri,
    meta?.["ui/resourceUri"],
    meta?.["openai/outputTemplate"],
    record(structuredMeta?.ui)?.resourceUri,
    structuredMeta?.["ui/resourceUri"],
    structuredMeta?.["openai/outputTemplate"],
  ]) {
    const uri = nonEmptyString(candidate);
    if (uri) return uri;
  }
  return undefined;
};

const isMCPAppResource = (
  mediaType: unknown,
  uri: unknown,
  advertisedURI?: string,
): boolean => {
  const candidateURI = nonEmptyString(uri);
  return harnessArtifactKind(String(mediaType || "application/octet-stream")) === "mcpApp"
    || candidateURI?.startsWith("ui://") === true
    || Boolean(advertisedURI && candidateURI === advertisedURI);
};

/** Extract displayable MCP/ACP content without retaining an opaque provider payload. */
export const harnessArtifactsFromToolResult = (
  resultValue: unknown,
  options: Omit<ArtifactOptions, "context">,
): HarnessArtifactUpdate[] => {
  const result = resultEnvelope(resultValue);
  if (!result) return [];
  const context = harnessArtifactContext({
    content: result.content,
    structuredContent: result.structuredContent,
    _meta: result._meta,
  });
  const title = options.title || titleFromResult(result) || options.tool || "Artifact";
  const artifacts: HarnessArtifactUpdate[] = [];
  const metaArtifact = record(record(result._meta)?.artifact);
  const advertisedURI = options.uri || mcpAppResourceURI(result);
  const inlineHTML = boundedUTF8(metaArtifact?.html);
  if (inlineHTML) {
    const inlineTitle = typeof metaArtifact?.title === "string" ? metaArtifact.title : title;
    artifacts.push(harnessArtifactFromResource({
      uri: advertisedURI,
      mimeType: "text/html;profile=mcp-app",
      text: inlineHTML,
    }, {
      ...options,
      context,
      title: inlineTitle,
      forceKind: "mcpApp",
      interactive: true,
      displayMode: metaArtifact?.displayMode === "inline" ? "inline" : "fullscreen",
    })!);
  }

  const content = Array.isArray(result.content) ? result.content : [];
  for (const [index, value] of content.entries()) {
    const item = record(value);
    if (!item) continue;
    if (item.type === "resource") {
      const resource = record(item.resource);
      const isMCPApp = isMCPAppResource(
        resource?.mimeType,
        resource?.uri,
        advertisedURI,
      );
      const artifact = harnessArtifactFromResource(item.resource, {
        ...options,
        context,
        title,
        ...(isMCPApp ? {
          forceKind: "mcpApp" as const,
          interactive: true,
          displayMode: "inline" as const,
        } : {}),
      }, index);
      if (artifact) artifacts.push(artifact);
      continue;
    }
    if (item.type === "resource_link") {
      const uri = typeof item.uri === "string" ? item.uri.slice(0, 4_096) : undefined;
      const linkTitle = String(item.title || item.name || title).slice(0, 160);
      const mediaType = String(item.mimeType || "application/octet-stream").slice(0, 160);
      const isMCPApp = isMCPAppResource(mediaType, uri, advertisedURI);
      artifacts.push({
        id: artifactID({ ...options, uri, context }, mediaType, undefined, index),
        kind: isMCPApp ? "mcpApp" : "link",
        title: linkTitle,
        mediaType,
        fileName: fileNameFor(linkTitle, mediaType, uri),
        ...(uri ? { uri } : {}),
        ...(isMCPApp ? { interactive: true, displayMode: "inline" as const } : {}),
        provider: options.provider,
        ...(options.server ? { server: options.server } : {}),
        ...(options.tool ? { tool: options.tool } : {}),
      });
      continue;
    }
    if (item.type === "image" || item.type === "audio") {
      const mediaType = String(item.mimeType || (item.type === "image" ? "image/png" : "audio/mpeg"));
      const data = boundedUTF8(item.data);
      if (!data) continue;
      const artifact = harnessArtifactFromResource({ mimeType: mediaType, blob: data }, {
        ...options,
        context,
        title,
      }, index);
      if (artifact) artifacts.push(artifact);
    }
  }
  return [...new Map(artifacts.map((artifact) => [artifact.id, artifact])).values()].slice(0, 8);
};
