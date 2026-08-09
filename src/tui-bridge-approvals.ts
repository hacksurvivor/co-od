export type BridgeApprovalDecision = "approve" | "deny";

export type BridgeApprovalRequest = {
  approvalId: string;
  agentId?: string;
  method?: string;
  requestId?: string;
  kind?: string;
  mode?: string;
  status?: string;
  summary?: string;
  reason?: string;
  command?: string;
  cwd?: string;
  files?: string[];
  requestedAt?: string;
  expiresAt?: string;
  timeoutMs?: number;
};

const objectValue = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const requestIdValue = (value: unknown): string | undefined =>
  typeof value === "number" || typeof value === "string" ? String(value) : undefined;

function commandValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const command = value.map((part) => String(part)).join(" ").trim();
    return command || undefined;
  }
  return stringValue(value);
}

function fileValues(record: Record<string, unknown>): string[] | undefined {
  const files = Array.isArray(record.files)
    ? record.files.filter((file): file is string => typeof file === "string" && file.trim().length > 0)
    : [];
  const fileChanges = objectValue(record.fileChanges);
  const changedFiles = fileChanges ? Object.keys(fileChanges).filter(Boolean) : [];
  const grantRoot = stringValue(record.grantRoot);
  const values = [...files, ...changedFiles, ...(grantRoot ? [grantRoot] : [])];
  return values.length > 0 ? Array.from(new Set(values)).slice(0, 20) : undefined;
}

export function defaultLocalBridgeUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.CO_OD_LOCAL_BRIDGE_URL || env.NEXT_PUBLIC_LOCAL_BRIDGE_URL || "http://127.0.0.1:4786").replace(/\/$/, "");
}

export function parseBridgeApprovalRequest(data: unknown): BridgeApprovalRequest | null {
  let value: unknown = data;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }

  const record = objectValue(value);
  const approvalId = stringValue(record?.approvalId);
  if (!record || !approvalId) return null;

  return {
    approvalId,
    agentId: stringValue(record.agentId),
    method: stringValue(record.method),
    requestId: requestIdValue(record.requestId),
    kind: stringValue(record.kind),
    mode: stringValue(record.mode),
    status: stringValue(record.status),
    summary: stringValue(record.summary),
    reason: stringValue(record.reason),
    command: commandValue(record.command),
    cwd: stringValue(record.cwd),
    files: fileValues(record),
    requestedAt: stringValue(record.requestedAt),
    expiresAt: stringValue(record.expiresAt),
    timeoutMs: typeof record.timeoutMs === "number" ? record.timeoutMs : undefined,
  };
}

export function bridgeApprovalKindLabel(kind?: string): string {
  if (kind === "file-edit") return "file edit";
  if (kind === "shell") return "shell command";
  if (kind === "network") return "network access";
  if (kind === "destructive") return "destructive command";
  if (kind === "permissions") return "permissions";
  if (kind === "unknown") return "unsupported operation";
  return kind?.replace(/[-_]+/g, " ").trim() || "operation";
}

export function bridgeApprovalTarget(approval: BridgeApprovalRequest): string {
  if (approval.command) return approval.command;
  if (approval.files && approval.files.length > 0) return approval.files.join(", ");
  return approval.summary || "operation";
}

export function bridgeApprovalTitle(approval: BridgeApprovalRequest): string {
  return `${bridgeApprovalKindLabel(approval.kind)} approval`;
}

export function bridgeApprovalDetailLines(approval: BridgeApprovalRequest): string[] {
  const target = bridgeApprovalTarget(approval);
  const method = approval.method
    ? `method: ${approval.method}${approval.requestId ? ` #${approval.requestId}` : ""}`
    : approval.requestId
      ? `request: #${approval.requestId}`
      : undefined;
  return [
    target,
    approval.cwd ? `cwd: ${approval.cwd}` : undefined,
    approval.reason ? `reason: ${approval.reason}` : undefined,
    method,
    approval.expiresAt ? `expires: ${approval.expiresAt}` : undefined,
  ].filter((line): line is string => Boolean(line));
}

export function parseBridgeApprovalSseBlock(block: string): BridgeApprovalRequest | null {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  if (!data) return null;
  try {
    const event = JSON.parse(data) as { type?: unknown; data?: unknown };
    if (event.type !== "approval_request") return null;
    return parseBridgeApprovalRequest(event.data);
  } catch {
    return null;
  }
}

export async function respondToBridgeApproval(input: {
  bridgeUrl?: string;
  approvalId: string;
  decision: BridgeApprovalDecision;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const fetchImpl = input.fetchImpl || fetch;
  const bridgeUrl = (input.bridgeUrl || defaultLocalBridgeUrl()).replace(/\/$/, "");
  const response = await fetchImpl(`${bridgeUrl}/v1/approvals/${encodeURIComponent(input.approvalId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision: input.decision }),
  });
  if (!response.ok) {
    throw new Error(`approval failed: ${response.status} ${response.statusText}`);
  }
}
