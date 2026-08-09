export interface TuiSafetyState {
  approvalMode: string;
  sandboxMode: string;
  networkEnabled: boolean | null;
  autoRun: boolean;
  autoApply: boolean;
  allowDangerousCommands: boolean;
  audit: TuiSafetyAuditEntry[];
}

export interface TuiSafetyAuditEntry {
  action: string;
  decision: "allowed" | "blocked" | "toggled" | "info";
  reason: string;
  createdAt: number;
}

export interface SafetyProviderPolicy {
  provider: string;
  approvalMode: string;
  sandboxMode: string;
  networkEnabled: boolean | null;
  note: string;
}

export type SafetyToggle = "auto-run" | "auto-apply" | "network" | "dangerous";
export type TuiSafetyAction = "task" | "file-edit" | "shell" | "network" | "destructive";

export function createSafetyState(env: NodeJS.ProcessEnv = process.env): TuiSafetyState {
  return {
    approvalMode: env.CODEX_APPROVAL_POLICY || env.APPROVAL_POLICY || "local-cli",
    sandboxMode: env.CODEX_SANDBOX_MODE || env.SANDBOX_MODE || "provider-default",
    networkEnabled: parseOptionalBoolean(env.CODEX_NETWORK_ACCESS || env.NETWORK_ACCESS),
    autoRun: true,
    autoApply: false,
    allowDangerousCommands: false,
    audit: [],
  };
}

export function providerSafetyPolicy(provider: string): SafetyProviderPolicy {
  if (provider === "codex") {
    return {
      provider,
      approvalMode: "full-auto",
      sandboxMode: "codex --full-auto",
      networkEnabled: null,
      note: "codex adapter currently invokes codex exec --full-auto",
    };
  }
  if (provider === "claude") {
    return {
      provider,
      approvalMode: "claude-cli",
      sandboxMode: "claude defaults",
      networkEnabled: null,
      note: "claude adapter delegates policy to Claude Code",
    };
  }
  if (provider === "opencode") {
    return {
      provider,
      approvalMode: "opencode-cli",
      sandboxMode: "opencode defaults",
      networkEnabled: null,
      note: "opencode adapter delegates policy to OpenCode",
    };
  }
  return {
    provider,
    approvalMode: "provider-default",
    sandboxMode: "provider-default",
    networkEnabled: null,
    note: "provider policy is not declared",
  };
}

export function safetySummary(state: TuiSafetyState, provider: string): string {
  const policy = providerSafetyPolicy(provider);
  return [
    `approval ${policy.approvalMode || state.approvalMode}`,
    `sandbox ${policy.sandboxMode || state.sandboxMode}`,
    `network ${formatSafetyBoolean(policy.networkEnabled ?? state.networkEnabled)}`,
    `auto-run ${state.autoRun ? "on" : "off"}`,
    `auto-apply ${state.autoApply ? "on" : "off"}`,
    `dangerous ${state.allowDangerousCommands ? "allowed" : "blocked"}`,
  ].join("  ");
}

export function safetyLines(state: TuiSafetyState, provider: string): string[] {
  const policy = providerSafetyPolicy(provider);
  return [
    `approval   ${policy.approvalMode || state.approvalMode}`,
    `sandbox    ${policy.sandboxMode || state.sandboxMode}`,
    `network    ${formatSafetyBoolean(policy.networkEnabled ?? state.networkEnabled)}`,
    `auto-run   ${state.autoRun ? "on" : "off"}`,
    `auto-apply ${state.autoApply ? "on" : "off"}`,
    `dangerous  ${state.allowDangerousCommands ? "allowed" : "blocked"}`,
    `policy     ${policy.note}`,
  ];
}

export function toggleSafety(state: TuiSafetyState, target: string): {
  ok: boolean;
  state: TuiSafetyState;
  message: string;
} {
  const normalized = normalizeToggle(target);
  if (!normalized) {
    return {
      ok: false,
      state,
      message: "Toggle one of: auto-run, auto-apply, network, dangerous.",
    };
  }

  const next = { ...state, audit: [...state.audit] };
  if (normalized === "auto-run") {
    next.autoRun = !next.autoRun;
  } else if (normalized === "auto-apply") {
    next.autoApply = !next.autoApply;
  } else if (normalized === "network") {
    next.networkEnabled = !(next.networkEnabled === true);
  } else {
    next.allowDangerousCommands = !next.allowDangerousCommands;
  }

  const value = safetyToggleValue(next, normalized);
  const message = `${normalized} ${value}`;
  return {
    ok: true,
    state: addSafetyAudit(next, normalized, "toggled", message),
    message,
  };
}

export function ensureTaskAllowed(state: TuiSafetyState): {
  ok: boolean;
  state: TuiSafetyState;
  message: string;
} {
  const decision = evaluateTaskApproval(state);
  if (decision.status === "allowed") {
    return {
      ok: true,
      state: decision.state,
      message: decision.message,
    };
  }
  return {
    ok: false,
    state: addSafetyAudit(state, "task", "blocked", "auto-run disabled"),
    message: "Task blocked: auto-run is off. Use /safety toggle auto-run to enable task submission.",
  };
}

export type SafetyActionApprovalDecision =
  | { status: "allowed"; state: TuiSafetyState; message: string }
  | { status: "needs-approval"; state: TuiSafetyState; message: string };

export type TaskApprovalDecision = SafetyActionApprovalDecision;

export function evaluateTaskApproval(state: TuiSafetyState, options: { approved?: boolean } = {}): TaskApprovalDecision {
  return evaluateSafetyActionApproval(state, "task", options);
}

export function evaluateSafetyActionApproval(
  state: TuiSafetyState,
  action: TuiSafetyAction,
  options: { approved?: boolean } = {},
): SafetyActionApprovalDecision {
  const allowed = actionAllowedByPolicy(state, action);
  if (allowed) {
    return {
      status: "allowed",
      state: addSafetyAudit(state, action, "allowed", actionPolicyReason(action)),
      message: `${safetyActionLabel(action)} allowed by local policy.`,
    };
  }
  if (options.approved) {
    return {
      status: "allowed",
      state: addSafetyAudit(state, action, "allowed", "manually approved in TUI"),
      message: `${safetyActionLabel(action)} allowed by manual TUI approval.`,
    };
  }
  return {
    status: "needs-approval",
    state,
    message: `${safetyActionLabel(action)} needs approval because ${actionBlockReason(state, action)}.`,
  };
}

export function addSafetyAudit(
  state: TuiSafetyState,
  action: string,
  decision: TuiSafetyAuditEntry["decision"],
  reason: string,
  now = Date.now(),
): TuiSafetyState {
  return {
    ...state,
    audit: [...state.audit, { action, decision, reason, createdAt: now }].slice(-50),
  };
}

function normalizeToggle(value: string): SafetyToggle | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "autorun" || normalized === "run" || normalized === "auto-run") {
    return "auto-run";
  }
  if (normalized === "autoapply" || normalized === "apply" || normalized === "auto-apply") {
    return "auto-apply";
  }
  if (normalized === "net" || normalized === "network") {
    return "network";
  }
  if (normalized === "danger" || normalized === "dangerous" || normalized === "dangerous-commands") {
    return "dangerous";
  }
  return null;
}

function safetyToggleValue(state: TuiSafetyState, toggle: SafetyToggle): string {
  if (toggle === "auto-run") return state.autoRun ? "on" : "off";
  if (toggle === "auto-apply") return state.autoApply ? "on" : "off";
  if (toggle === "network") return formatSafetyBoolean(state.networkEnabled);
  return state.allowDangerousCommands ? "allowed" : "blocked";
}

function actionAllowedByPolicy(state: TuiSafetyState, action: TuiSafetyAction): boolean {
  if (action === "task" || action === "shell") return state.autoRun;
  if (action === "file-edit") return state.autoApply;
  if (action === "network") return state.networkEnabled !== false;
  return state.allowDangerousCommands;
}

function actionPolicyReason(action: TuiSafetyAction): string {
  if (action === "task") return "auto-run enabled";
  if (action === "shell") return "auto-run enabled";
  if (action === "file-edit") return "auto-apply enabled";
  if (action === "network") return "network allowed by local policy";
  return "dangerous commands allowed";
}

function actionBlockReason(state: TuiSafetyState, action: TuiSafetyAction): string {
  if (action === "task" || action === "shell") return "auto-run is off";
  if (action === "file-edit") return "auto-apply is off";
  if (action === "network") return "network is disabled";
  return state.allowDangerousCommands ? "policy requires confirmation" : "dangerous commands are blocked";
}

function safetyActionLabel(action: TuiSafetyAction): string {
  if (action === "file-edit") return "File edit";
  if (action === "shell") return "Shell command";
  return `${action[0].toUpperCase()}${action.slice(1)}`;
}

function parseOptionalBoolean(value?: string): boolean | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
  return null;
}

function formatSafetyBoolean(value: boolean | null): string {
  if (value === true) return "enabled";
  if (value === false) return "disabled";
  return "provider-default";
}
