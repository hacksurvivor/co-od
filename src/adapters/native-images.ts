import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { TuiAttachmentTransport } from "../tui-attachments.js";

const mimeTypes: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp",
};

/** Keep original bytes. Other formats retain their native file references. */
export async function nativeImageAttachments(attachments?: TuiAttachmentTransport[]) {
  return Promise.all((attachments ?? []).filter((attachment) => attachment.exists
    && attachment.kind === "image" && mimeTypes[extname(attachment.absolutePath).toLowerCase()])
    .map(async (attachment) => ({
      type: "image" as const,
      mimeType: mimeTypes[extname(attachment.absolutePath).toLowerCase()]!,
      data: (await readFile(attachment.absolutePath)).toString("base64"),
    })));
}
