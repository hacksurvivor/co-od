import { inferAttachmentKind, type TuiAttachment } from "./tui-attachments.js";

export interface FileMentionResolution {
  attachments: TuiAttachment[];
  matched: Array<{ ref: string; path: string }>;
  unresolved: string[];
}

const FILE_MENTION_PATTERN = /(^|[\s([{])@(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.~+/@:-][^\s,;)\]}]*))/g;

export function extractFileMentionRefs(text: string): string[] {
  const refs: string[] = [];
  for (const match of text.matchAll(FILE_MENTION_PATTERN)) {
    const ref = (match[2] || match[3] || match[4] || "").trim();
    const normalized = ref.replace(/[.!?]+$/, "");
    if (normalized && !refs.includes(normalized)) refs.push(normalized);
  }
  return refs;
}

export function resolveFileMentionAttachments(input: {
  goal: string;
  files: string[];
  currentAttachments?: TuiAttachment[];
}): FileMentionResolution {
  const attachments = [...(input.currentAttachments || [])];
  const matched: FileMentionResolution["matched"] = [];
  const unresolved: string[] = [];

  for (const ref of extractFileMentionRefs(input.goal)) {
    const path = resolveFileRef(ref, input.files);
    if (!path) {
      unresolved.push(ref);
      continue;
    }
    matched.push({ ref, path });
    if (!attachments.some((attachment) => attachment.path === path)) {
      attachments.push({ path, kind: inferAttachmentKind(path) });
    }
  }

  return { attachments, matched, unresolved };
}

export function fileMentionAttachmentsChanged(
  before: TuiAttachment[],
  after: TuiAttachment[],
): boolean {
  if (before.length !== after.length) return true;
  return before.some((attachment, index) => {
    const next = after[index];
    return !next || attachment.path !== next.path || attachment.kind !== next.kind;
  });
}

export function resolveFileRef(ref: string, files: string[]): string | null {
  const normalizedRef = ref.replace(/^\.\//, "");
  const exact = files.find((file) => file === normalizedRef || file === ref);
  if (exact) return exact;

  const suffixMatches = files.filter((file) => file.endsWith(`/${normalizedRef}`) || file.endsWith(normalizedRef));
  if (suffixMatches.length === 1) return suffixMatches[0];

  if (!normalizedRef.includes("/")) {
    const basenameMatches = files.filter((file) => file.split("/").pop() === normalizedRef);
    if (basenameMatches.length === 1) return basenameMatches[0];
  }

  return null;
}
