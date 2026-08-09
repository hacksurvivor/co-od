export interface HarnessWorkspaceAccess {
  toolPath: string;
  serverURL: string;
  capability: string;
  roomID: string;
  runID: string;
  expiresAt: string;
  /** Native app-server turns use this direct relay callback. */
  invoke?: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
}

interface WorkspaceToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const string = (description: string): Record<string, unknown> => ({ type: "string", description });
const boolean = (description: string): Record<string, unknown> => ({ type: "boolean", description });
const schedule = (): Record<string, unknown> => objectSchema({
  frequency: {
    type: "string",
    enum: ["once", "hourly", "daily", "weekdays", "weekly"],
    description: "How often the automation runs.",
  },
  anchor: {
    type: "string",
    pattern: "(?:Z|[+-]\\d{2}:\\d{2})$",
    description: "An unambiguous ISO-8601 date-time with timezone. For recurring schedules, its local weekday and time are reused.",
  },
  time_zone: string("IANA time zone such as Asia/Bangkok or America/New_York. Never guess when the user has not supplied or clearly implied it."),
}, ["frequency", "anchor", "time_zone"]);

export const WORKSPACE_TOOL_DEFINITIONS: WorkspaceToolDefinition[] = [
  {
    name: "create_automation",
    description: "Create a co·ode automation after the user explicitly asks for recurring or future work. Convert the user's stated time into an ISO-8601 anchor; do not guess an omitted time or timezone.",
    inputSchema: objectSchema({
      title: string("Short name shown in Schedules."),
      prompt: string("The complete task the selected harness should perform on every run."),
      schedule: schedule(),
      harness: string("Optional connected harness name. Omit to use the current harness."),
      enabled: boolean("Whether the automation starts active. Defaults to true."),
    }, ["title", "prompt", "schedule"]),
  },
  {
    name: "list_automations",
    description: "List this user's co·ode automations and their next run state.",
    inputSchema: objectSchema({ include_archived: boolean("Include archived automations.") }),
  },
  {
    name: "update_automation",
    description: "Update an existing co·ode automation. Supply only fields the user asked to change.",
    inputSchema: objectSchema({
      automation_id: string("Automation ID from list_automations."),
      title: string("Replacement display name."),
      prompt: string("Replacement task prompt."),
      schedule: schedule(),
      harness: string("Replacement harness name. Omit to keep the current harness."),
      enabled: boolean("Whether it is active."),
    }, ["automation_id"]),
  },
  {
    name: "pause_automation",
    description: "Pause an automation without deleting it.",
    inputSchema: objectSchema({ automation_id: string("Automation ID.") }, ["automation_id"]),
  },
  {
    name: "resume_automation",
    description: "Resume a paused automation when it still has a valid future run.",
    inputSchema: objectSchema({ automation_id: string("Automation ID.") }, ["automation_id"]),
  },
  {
    name: "run_automation",
    description: "Queue an automation to run immediately while preserving its recurrence.",
    inputSchema: objectSchema({ automation_id: string("Automation ID.") }, ["automation_id"]),
  },
  {
    name: "delete_automation",
    description: "Archive an automation. This is reversible and does not delete prior task history.",
    inputSchema: objectSchema({ automation_id: string("Automation ID.") }, ["automation_id"]),
  },
  {
    name: "list_tasks",
    description: "List co·ode tasks across harnesses, including status, pin, project, and fork relationships.",
    inputSchema: objectSchema({ include_archived: boolean("Include archived tasks.") }),
  },
  {
    name: "read_task",
    description: "Read recent user and assistant messages from a co·ode task.",
    inputSchema: objectSchema({
      task_id: string("Task ID from list_tasks."),
      limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum messages; defaults to 20." },
    }, ["task_id"]),
  },
  {
    name: "create_task",
    description: "Create a new co·ode task, optionally queueing its first prompt. Use this for genuinely separate work, not as a substitute for answering in the current task.",
    inputSchema: objectSchema({
      title: string("Short task title."),
      prompt: string("Optional first prompt. If omitted the task is created idle."),
      harness: string("Optional connected harness name; defaults to the current harness."),
      pinned: boolean("Pin the task in the sidebar."),
    }, ["title"]),
  },
  {
    name: "send_message",
    description: "Queue a follow-up message in an existing co·ode task, preserving its provider session.",
    inputSchema: objectSchema({
      task_id: string("Destination task ID."),
      message: string("Message to send."),
    }, ["task_id", "message"]),
  },
  {
    name: "rename_task",
    description: "Rename a co·ode task.",
    inputSchema: objectSchema({ task_id: string("Task ID."), title: string("New title.") }, ["task_id", "title"]),
  },
  {
    name: "pin_task",
    description: "Pin or unpin a co·ode task.",
    inputSchema: objectSchema({ task_id: string("Task ID."), pinned: boolean("True to pin, false to unpin.") }, ["task_id", "pinned"]),
  },
  {
    name: "archive_task",
    description: "Archive a completed or unwanted co·ode task without deleting its history.",
    inputSchema: objectSchema({ task_id: string("Task ID.") }, ["task_id"]),
  },
  {
    name: "unarchive_task",
    description: "Restore an archived co·ode task.",
    inputSchema: objectSchema({ task_id: string("Task ID.") }, ["task_id"]),
  },
  {
    name: "fork_task",
    description: "Fork a co·ode task into an independent task. Provider-native history is forked when the harness supports it.",
    inputSchema: objectSchema({
      task_id: string("Source task ID."),
      title: string("Title for the fork."),
      prompt: string("Optional first prompt for the fork."),
      harness: string("Optional connected harness. Omit to keep the source harness."),
    }, ["task_id", "title"]),
  },
  {
    name: "list_documents",
    description: "List the Room's co·work Docs and their document IDs. This is read-only.",
    inputSchema: objectSchema({}),
  },
  {
    name: "read_document",
    description: "Read one co·work Doc with its stable paragraph block IDs before proposing changes. This is read-only.",
    inputSchema: objectSchema({
      document_id: string("Document ID from list_documents."),
    }, ["document_id"]),
  },
  {
    name: "propose_document",
    description: "Propose paragraph-level changes to a co·work Doc for a full-access member to review. This never writes the document directly. Read the document first and use its exact block IDs for replacements and insertion anchors.",
    inputSchema: objectSchema({
      document_id: string("Document ID from list_documents."),
      note: string("Short explanation of the proposed change for the reviewer."),
      edits: {
        type: "array",
        minItems: 1,
        maxItems: 2000,
        description: "Paragraph changes. Omit replaces to add a paragraph; use empty text with replaces to remove one.",
        items: objectSchema({
          replaces: string("Existing block ID to revise or remove. Omit for an addition."),
          text: string("Proposed paragraph text. Empty text removes the block named by replaces."),
          after: string("Existing block ID after which a new paragraph belongs. Omit to append."),
        }, ["text"]),
      },
    }, ["document_id", "edits"]),
  },
];

export const codexWorkspaceDynamicTools = (): Array<Record<string, unknown>> => [{
  type: "namespace",
  name: "coode",
  description: "Manage co·ode automations and tasks, and propose changes to co·work Docs in the current Room.",
  tools: WORKSPACE_TOOL_DEFINITIONS.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  })),
}];

export const workspaceToolEnvironment = (
  access?: HarnessWorkspaceAccess,
): Record<string, string> => access ? {
  CO_OD_WORKSPACE_TOOL: access.toolPath,
  CO_OD_WORKSPACE_SERVER_URL: access.serverURL,
  CO_OD_WORKSPACE_CAPABILITY: access.capability,
  CO_OD_WORKSPACE_ROOM_ID: access.roomID,
  CO_OD_WORKSPACE_RUN_ID: access.runID,
  CO_OD_WORKSPACE_EXPIRES_AT: access.expiresAt,
} : {};

export const promptWithWorkspaceAccess = (
  goal: string,
  access?: HarnessWorkspaceAccess,
  { nativeDynamicTools = false } = {},
): string => {
  if (!access) return goal;
  // Codex app-server already receives schema-constrained dynamic tools with
  // self-contained descriptions. Repeating the entire Room-management
  // contract inside every user message changes a simple chat into an apparent
  // orchestration task and encourages unnecessary tool use. Other harnesses
  // still need the shell invocation contract below.
  if (nativeDynamicTools) return goal;
  const invocation = "Call a tool by piping one JSON object to `$CO_OD_WORKSPACE_TOOL TOOL_NAME`.";
  return [
    "<co-ode-workspace-tools>",
    "You can manage this Room's automations and tasks when the user explicitly asks.",
    invocation,
    "Automation tools: create_automation, list_automations, update_automation, pause_automation, resume_automation, run_automation, delete_automation.",
    "Task tools: list_tasks, read_task, create_task, send_message, rename_task, pin_task, archive_task, unarchive_task, fork_task.",
    "Document tools: list_documents and read_document are read-only; propose_document creates a reviewable paragraph proposal and never writes agreed document text.",
    "Do not turn an ordinary coding request into an automation or another task. Do not guess an omitted time, timezone, destination task, or harness; ask the user when the choice is material.",
    "Creating, updating, pausing, resuming, pinning, archiving, and forking are reflected in co·ode immediately. Archive is reversible.",
    "Never print, copy, log, or expose CO_OD_WORKSPACE_* environment values or capabilities.",
    "</co-ode-workspace-tools>",
    "",
    "<task>",
    goal,
    "</task>",
  ].join("\n");
};

export const invokeWorkspaceTool = async (
  access: HarnessWorkspaceAccess | undefined,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> => {
  if (!access?.invoke) throw new Error("The co·ode workspace tool is unavailable for this turn.");
  return access.invoke(tool, args);
};
