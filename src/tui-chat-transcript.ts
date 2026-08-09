import type { TuiTaskEvent } from "./tui-task.js";

export type TranscriptBlock =
  | { kind: "markdown"; text: string }
  | { kind: "code"; lang?: string; text: string }
  | { kind: "diff"; patchId: string; runId?: string; file?: string; diff: string; status: "proposed" | "accepted" | "rejected" }
  | { kind: "toolCall"; label: string; detail?: string };

export type DiffBlockPayload = Omit<Extract<TranscriptBlock, { kind: "diff" }>, "kind">;

export interface TranscriptMessage {
  id: string;
  role: "you" | "agent";
  agentName?: string;
  provider?: string;
  blocks: TranscriptBlock[];
  streaming?: boolean;
  /** Room chat turn (`#` messages) — rendered as conversation, not status. */
  chat?: boolean;
  /** Display name for a chat turn ("you" for own messages). */
  author?: string;
  /** Own chat message (muted) vs a teammate's (foreground). */
  mine?: boolean;
  /** Epoch ms the chat message was created — drives the relative stamp. */
  at?: number;
}

export interface FoldContext {
  messageId: string;
  agentName?: string;
}

export function createEmptyTranscript(): TranscriptMessage[] {
  return [];
}

export function appendUserMessage(transcript: TranscriptMessage[], text: string, id: string): TranscriptMessage[] {
  return [...transcript, { id, role: "you", blocks: [{ kind: "markdown", text }] }];
}

/** Append a room-chat turn — yours or a teammate's — to the conversation. */
export function appendChatTurn(
  transcript: TranscriptMessage[],
  input: { id: string; author: string; body: string; mine?: boolean; at?: number },
): TranscriptMessage[] {
  if (transcript.some((message) => message.id === input.id)) return transcript;
  return [...transcript, {
    id: input.id,
    role: "you",
    chat: true,
    author: input.author,
    mine: input.mine === true,
    at: input.at,
    blocks: [{ kind: "markdown", text: input.body }],
  }];
}

function replaceMessage(
  transcript: TranscriptMessage[],
  id: string,
  update: (message: TranscriptMessage) => TranscriptMessage,
): TranscriptMessage[] {
  return transcript.map((message) => (message.id === id ? update(message) : message));
}

function appendMarkdown(message: TranscriptMessage, text: string): TranscriptMessage {
  const last = message.blocks.at(-1);
  if (last && last.kind === "markdown") {
    const blocks = message.blocks.slice(0, -1);
    blocks.push({ kind: "markdown", text: last.text + text });
    return { ...message, blocks };
  }
  return { ...message, blocks: [...message.blocks, { kind: "markdown", text }] };
}

export function foldTaskEventIntoTranscript(
  transcript: TranscriptMessage[],
  event: TuiTaskEvent,
  context: FoldContext,
): TranscriptMessage[] {
  switch (event.type) {
    case "submitted": {
      const message: TranscriptMessage = {
        id: context.messageId,
        role: "agent",
        agentName: context.agentName,
        provider: event.provider,
        blocks: [],
        streaming: true,
      };
      return [...transcript, message];
    }
    case "status":
      // Status text is shown only as a preamble before any output arrives.
      return replaceMessage(transcript, context.messageId, (message) =>
        message.blocks.length === 0 ? appendMarkdown(message, `_${event.message}_\n`) : message,
      );
    case "output":
      return replaceMessage(transcript, context.messageId, (message) => appendMarkdown(message, event.data));
    case "complete":
      return replaceMessage(transcript, context.messageId, (message) => ({ ...message, streaming: false }));
    case "error":
      return replaceMessage(transcript, context.messageId, (message) => ({
        ...appendMarkdown(message, `**Error:** ${event.message}`),
        streaming: false,
      }));
    default:
      return transcript;
  }
}

export function addPatchBlock(
  transcript: TranscriptMessage[],
  messageId: string,
  patch: DiffBlockPayload,
): TranscriptMessage[] {
  return replaceMessage(transcript, messageId, (message) => ({
    ...message,
    blocks: [...message.blocks, { kind: "diff", ...patch }],
  }));
}

export function setPatchStatus(
  transcript: TranscriptMessage[],
  patchId: string,
  status: "accepted" | "rejected",
): TranscriptMessage[] {
  return transcript.map((message) => ({
    ...message,
    blocks: message.blocks.map((block) =>
      block.kind === "diff" && block.patchId === patchId ? { ...block, status } : block,
    ),
  }));
}
