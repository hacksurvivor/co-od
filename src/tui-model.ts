export interface AgentRunRecord {
  _id: string;
  agent_id?: string;
  goal?: string;
  status?: string;
  execution_mode?: string;
  parent_run_id?: string;
  root_run_id?: string;
  subagent_role?: string;
  delegation_depth?: number;
  handoff_from?: string;
  handoff_context?: string;
  join_summary_md?: string;
  created_at?: number;
  started_at?: number;
  finished_at?: number;
  heartbeat_at?: number;
  lease_expires_at?: number;
  token_estimate?: number;
  steps?: AgentRunStepRecord[];
}

export interface AgentRunStepRecord {
  _id?: string;
  idx?: number;
  kind?: string;
  input?: Record<string, unknown>;
  output?: {
    success?: boolean;
    payload?: Record<string, unknown>;
  };
  created_at?: number;
}

export interface BackendApprovalStep {
  kind: string;
  decision: "approved" | "denied" | string;
  mode?: string;
  summary?: string;
  reason?: string;
  command?: string;
  cwd?: string;
  files?: string[];
}

export interface PatchRecord {
  _id: string;
  run_id?: string;
  title?: string;
  path?: string;
  diff_text?: string;
  status?: "proposed" | "accepted" | "rejected";
  created_at?: number;
  resolved_at?: number;
  reject_reason?: string;
}

export interface RunDetailData {
  run: AgentRunRecord;
  patches: PatchRecord[];
  allRuns: AgentRunRecord[];
}

export type DiffLineKind = "meta" | "add" | "remove" | "context";

export interface DelegationRow {
  runId: string;
  status?: string;
  agentId?: string;
  role?: string;
  goal?: string;
  depth: number;
  relation: "root" | "spawn" | "handoff" | "cycle";
  selected: boolean;
}

export function compact(text: string | undefined, fallback = "-"): string {
  const value = text?.trim();
  return value ? value.replace(/\s+/g, " ") : fallback;
}

export function shortId(id: string | undefined): string {
  if (!id) return "-";
  return id.length > 10 ? id.slice(-10) : id;
}

export function stringifyCompact(value: unknown, fallback = "-"): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string") return compact(value, fallback);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return compact(JSON.stringify(value), fallback);
  } catch {
    return fallback;
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function approvalStepMetadata(step: AgentRunStepRecord): BackendApprovalStep | null {
  const outputPayload = objectValue(step.output?.payload);
  const approval = objectValue(outputPayload?.approval);
  const inputPayload = objectValue(step.input?.payload);
  const description = typeof step.input?.description === "string" ? step.input.description : "";
  const descriptionMatch = /^approval:([a-z-]+)$/i.exec(description.trim());

  if (!approval && !descriptionMatch) return null;

  const source = approval || {};
  const kind = typeof source.kind === "string"
    ? source.kind
    : descriptionMatch?.[1] || "unknown";
  const decision = typeof source.decision === "string"
    ? source.decision
    : step.output?.success === false
      ? "denied"
      : step.output?.success === true
        ? "approved"
        : "recorded";
  const files = Array.isArray(source.files)
    ? source.files.filter((file): file is string => typeof file === "string")
    : Array.isArray(inputPayload?.files)
      ? inputPayload.files.filter((file): file is string => typeof file === "string")
      : undefined;

  return {
    kind,
    decision,
    mode: typeof source.mode === "string" ? source.mode : undefined,
    summary: typeof source.summary === "string" ? source.summary : typeof inputPayload?.summary === "string" ? inputPayload.summary : undefined,
    reason: typeof source.reason === "string" ? source.reason : typeof inputPayload?.reason === "string" ? inputPayload.reason : undefined,
    command: typeof source.command === "string" ? source.command : typeof inputPayload?.command === "string" ? inputPayload.command : undefined,
    cwd: typeof source.cwd === "string" ? source.cwd : typeof inputPayload?.cwd === "string" ? inputPayload.cwd : undefined,
    files,
  };
}

export function formatApprovalStepDescription(approval: BackendApprovalStep): string {
  const decision = approval.decision === "approved"
    ? "Approved"
    : approval.decision === "denied"
      ? "Denied"
      : compact(approval.decision, "Recorded");
  const target = approval.command
    || (approval.files && approval.files.length > 0 ? approval.files.join(", ") : undefined)
    || approval.summary;
  const mode = approval.mode ? ` (${approval.mode})` : "";
  const reason = approval.reason ? ` - ${approval.reason}` : "";
  return `${decision} ${compact(approval.kind, "approval")}${mode}${target ? `: ${compact(target)}` : ""}${reason}`;
}

export function diffStat(diffText: string | undefined): string {
  if (!diffText) return "+0 -0";
  let added = 0;
  let removed = 0;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    if (line.startsWith("-")) removed++;
  }
  return `+${added} -${removed}`;
}

export function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "remove";
  return "context";
}

export function dedupeRuns(runs: AgentRunRecord[]): AgentRunRecord[] {
  const byId = new Map<string, AgentRunRecord>();
  for (const run of runs) {
    byId.set(run._id, run);
  }
  return Array.from(byId.values()).sort((left, right) => (right.created_at || 0) - (left.created_at || 0));
}

export function resolveRunId(runs: AgentRunRecord[], runRef?: string | number): string | null {
  if (typeof runRef === "number") {
    return runs[runRef]?._id || null;
  }

  const value = runRef?.trim();
  if (!value) {
    return runs[0]?._id || null;
  }
  if (/^\d+$/.test(value)) {
    return runs[Number(value) - 1]?._id || null;
  }

  return runs.find((run) => run._id === value || run._id.endsWith(value))?._id || value;
}

export function formatStepDescription(step: AgentRunStepRecord): string {
  const approval = approvalStepMetadata(step);
  if (approval) return formatApprovalStepDescription(approval);
  if (typeof step.input?.description === "string") return step.input.description;
  if (typeof step.output?.payload?.summary === "string") return step.output.payload.summary;
  if (typeof step.output?.payload?.text === "string") return step.output.payload.text;
  return stringifyCompact(step.input?.payload || step.output?.payload);
}

export function findDelegationRoot(run: AgentRunRecord, allRuns: AgentRunRecord[]): AgentRunRecord {
  const byId = new Map(allRuns.map((candidate) => [candidate._id, candidate]));
  let current = run;
  const seen = new Set<string>();
  while ((current.parent_run_id || current.handoff_from) && !seen.has(current._id)) {
    seen.add(current._id);
    const parent = byId.get(current.parent_run_id || current.handoff_from || "");
    if (!parent) break;
    current = parent;
  }
  const root = run.root_run_id ? byId.get(run.root_run_id) : null;
  return root || current;
}

export function buildDelegationRows(run: AgentRunRecord, allRuns: AgentRunRecord[]): DelegationRow[] {
  const root = findDelegationRoot(run, allRuns);
  return appendDelegationRows({
    run: root,
    selectedRunId: run._id,
    allRuns,
    depth: 0,
    relation: "root",
    seen: new Set<string>(),
  });
}

function appendDelegationRows(input: {
  run: AgentRunRecord;
  selectedRunId: string;
  allRuns: AgentRunRecord[];
  depth: number;
  relation: DelegationRow["relation"];
  seen: Set<string>;
}): DelegationRow[] {
  const { run, selectedRunId, allRuns, depth, relation, seen } = input;
  if (seen.has(run._id)) {
    return [{
      runId: run._id,
      status: run.status,
      agentId: run.agent_id,
      role: run.subagent_role,
      goal: run.goal,
      depth,
      relation: "cycle",
      selected: run._id === selectedRunId,
    }];
  }

  const nextSeen = new Set(seen);
  nextSeen.add(run._id);
  const rows: DelegationRow[] = [{
    runId: run._id,
    status: run.status,
    agentId: run.agent_id,
    role: run.subagent_role,
    goal: run.goal,
    depth,
    relation,
    selected: run._id === selectedRunId,
  }];

  const children = allRuns
    .filter((candidate) => candidate.parent_run_id === run._id)
    .sort((left, right) => (left.created_at || 0) - (right.created_at || 0));
  const handoffs = allRuns
    .filter((candidate) => candidate.handoff_from === run._id && candidate.parent_run_id !== run._id)
    .sort((left, right) => (left.created_at || 0) - (right.created_at || 0));

  for (const child of children) {
    rows.push(...appendDelegationRows({
      run: child,
      selectedRunId,
      allRuns,
      depth: depth + 1,
      relation: "spawn",
      seen: nextSeen,
    }));
  }
  for (const handoff of handoffs) {
    rows.push(...appendDelegationRows({
      run: handoff,
      selectedRunId,
      allRuns,
      depth: depth + 1,
      relation: "handoff",
      seen: nextSeen,
    }));
  }

  return rows;
}
