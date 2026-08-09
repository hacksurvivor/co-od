import { existsSync, realpathSync } from "node:fs";
import { findBunExecutable } from "./opentui.js";
import { getBaseUrl, getSession, type CachedSession } from "../api-client.js";
import {
  dashboardCachePolicyFromEnv,
  formatDashboardCachePolicy,
  readProjectConfig,
  type DashboardCachePolicy,
  type ProjectConfig,
} from "../tui-dashboard.js";
import { loadTuiProjectState, type TuiProjectState } from "../tui-persistence.js";

const MIN_NODE_MAJOR = 18;
const VERSION = "0.2.0";
const PACKAGE_NAME = "@codegrammer/co-od";

export type DoctorInstallKind = "repo" | "package" | "linked" | "unknown";

export interface DoctorCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  required?: boolean;
}

export interface DoctorReport {
  version: string;
  command: string;
  node: string;
  entrypoint: string;
  projectDir: string;
  server: string;
  installKind: DoctorInstallKind;
  checks: DoctorCheck[];
  strictReady: boolean;
  installHint: string;
  updateHint: string;
  completionHint: string;
  fullTuiHint: string;
  freePathHint: string;
  hostedRuntimeHint: string;
  liveQaHint: string;
  cachePolicy: DashboardCachePolicy;
}

interface DoctorOptions {
  version?: string;
  command?: string;
  nodeVersion?: string;
  entrypoint?: string;
  bun?: string | null;
  projectDir?: string;
  roomId?: string;
  server?: string;
  session?: CachedSession | null;
  projectConfig?: ProjectConfig | null;
  projectState?: Pick<TuiProjectState, "selectedRoomId" | "selectedRoomName"> | null;
  date?: Date;
  pathEnv?: string;
  opencodeBin?: string;
  cachePolicy?: DashboardCachePolicy;
  installKind?: DoctorInstallKind;
  commandExists?: (command: string) => boolean;
}

function resolveDoctorRoomContext(input: {
  roomId?: string;
  projectConfig?: ProjectConfig | null;
  projectState?: Pick<TuiProjectState, "selectedRoomId" | "selectedRoomName"> | null;
}): { roomId?: string; roomName?: string; source: "arg" | "config" | "persisted" | "none" } {
  if (input.roomId) {
    return {
      roomId: input.roomId,
      roomName: input.projectConfig?.roomId === input.roomId ? input.projectConfig.roomName : input.roomId,
      source: "arg",
    };
  }
  if (input.projectConfig?.roomId) {
    return {
      roomId: input.projectConfig.roomId,
      roomName: input.projectConfig.roomName,
      source: "config",
    };
  }
  if (input.projectState?.selectedRoomId) {
    return {
      roomId: input.projectState.selectedRoomId,
      roomName: input.projectState.selectedRoomName,
      source: "persisted",
    };
  }
  return { source: "none" };
}

function nodeMajor(version: string): number {
  const match = /^v?(\d+)/.exec(version.trim());
  return match ? Number(match[1]) : 0;
}

function pathCommandExists(command: string, pathEnv = process.env.PATH || ""): boolean {
  return pathEnv.split(":").some((dir) => Boolean(dir) && existsAt(`${dir}/${command}`));
}

function existsAt(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function providerCliChecks(options: DoctorOptions): DoctorCheck[] {
  const exists = options.commandExists || ((command: string) => pathCommandExists(command, options.pathEnv));
  const opencodeBin = options.opencodeBin || process.env.OPENCODE_BIN || "opencode";
  const providers = [
    { id: "provider-claude", label: "Provider claude", commands: ["claude"], install: "install Claude Code" },
    { id: "provider-codex", label: "Provider codex", commands: ["codex"], install: "install Codex CLI" },
    { id: "provider-hermes", label: "Provider hermes", commands: ["hermes"], install: "install Hermes Agent" },
    { id: "provider-opencode", label: "Provider opencode", commands: [opencodeBin], install: "install OpenCode" },
    { id: "provider-openclaw", label: "Provider openclaw", commands: ["zeroclaw", "openclaw"], install: "install ZeroClaw/OpenClaw" },
  ];

  return providers.map((provider) => {
    const found = provider.commands.find((command) => exists(command));
    return {
      id: provider.id,
      label: provider.label,
      ok: Boolean(found),
      detail: found
        ? `found ${found} in PATH`
        : `missing ${provider.commands.join(" or ")} in PATH; ${provider.install}`,
    };
  });
}

function detectInstallKind(input: {
  entrypoint: string;
  projectDir: string;
  installKind?: DoctorInstallKind;
}): DoctorInstallKind {
  if (input.installKind) return input.installKind;
  const normalizedEntry = resolveEntrypointPath(input.entrypoint).replace(/\\/g, "/");
  const normalizedProject = input.projectDir.replace(/\\/g, "/");
  if (
    normalizedEntry.includes(`/node_modules/${PACKAGE_NAME}/dist/index.js`) ||
    normalizedEntry.includes(`/node_modules/.pnpm/${PACKAGE_NAME.replace("/", "+")}@`)
  ) {
    return "package";
  }
  if (
    normalizedEntry.endsWith("/packages/cli/dist/index.js") ||
    normalizedEntry.startsWith(`${normalizedProject}/packages/cli/dist/`) ||
    normalizedEntry.startsWith(`${normalizedProject}/dist/`)
  ) {
    return "repo";
  }
  if (normalizedEntry.includes("/node_modules/") && normalizedEntry.endsWith("/dist/index.js")) {
    return "linked";
  }
  return "unknown";
}

function resolveEntrypointPath(entrypoint: string): string {
  try {
    return existsAt(entrypoint) ? realpathSync(entrypoint) : entrypoint;
  } catch {
    return entrypoint;
  }
}

function installKindDetail(kind: DoctorInstallKind): string {
  if (kind === "repo") return "repo checkout or linked workspace build";
  if (kind === "package") return `packaged install for ${PACKAGE_NAME}`;
  if (kind === "linked") return "linked Node package install";
  return "could not identify install source from entrypoint";
}

function installHintFor(kind: DoctorInstallKind): string {
  if (kind === "package") return `Package install: npm install -g ${PACKAGE_NAME}`;
  if (kind === "linked") return `Linked package: rebuild source package, then relink ${PACKAGE_NAME}`;
  if (kind === "unknown") return `Install package: npm install -g ${PACKAGE_NAME} or link this repo`;
  return "From this repo: pnpm build && pnpm link --global";
}

function readFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function roomSourceLabel(source: "arg" | "config" | "persisted" | "none"): string {
  if (source === "arg") return "--room";
  if (source === "config") return ".co-od.json";
  if (source === "persisted") return "persisted TUI state";
  return "none";
}

function updateHintFor(kind: DoctorInstallKind): string {
  if (kind === "package") return `Package update: npm update -g ${PACKAGE_NAME}`;
  if (kind === "linked") return "Linked update: pull source, pnpm install, rebuild, then relink";
  if (kind === "unknown") return `Update package: npm update -g ${PACKAGE_NAME} or pull and rebuild this repo`;
  return "After pulling updates: pnpm install && pnpm build";
}

export function strictDoctorFailures(report: Pick<DoctorReport, "checks">): DoctorCheck[] {
  return report.checks.filter((check) => check.required && !check.ok);
}

export function buildDoctorReport(options: DoctorOptions = {}): DoctorReport {
  const version = options.version || VERSION;
  const command = options.command || "co-od";
  const nodeVersion = options.nodeVersion || process.version;
  const entrypoint = options.entrypoint || process.argv[1] || "(unknown)";
  const bun = "bun" in options ? options.bun : findBunExecutable();
  const projectDir = options.projectDir || process.cwd();
  const server = options.server || getBaseUrl();
  const session = "session" in options ? options.session : getSession();
  const projectConfig = "projectConfig" in options
    ? options.projectConfig
    : readProjectConfig(projectDir, options.roomId);
  const projectState = "projectState" in options
    ? options.projectState
    : "projectConfig" in options
      ? null
      : loadTuiProjectState({ projectDir });
  const roomContext = resolveDoctorRoomContext({ roomId: options.roomId, projectConfig, projectState });
  const now = options.date || new Date();
  const nodeOk = nodeMajor(nodeVersion) >= MIN_NODE_MAJOR;
  const sessionOk = Boolean(session && session.expiresAt > now.getTime());
  const sessionDetail = sessionOk && session
    ? `cached session expires ${new Date(session.expiresAt).toISOString()}`
    : "no valid cached session; run `co-od login` before live room QA";
  const roomConfigDetail = roomContext.roomId
    ? `${roomContext.roomName || roomContext.roomId} (${roomContext.roomId}) via ${roomSourceLabel(roomContext.source)}`
    : "no room context in this project; run `co-od init`, open a pinned room in the TUI, or pass --room to live QA";
  const cachePolicy = options.cachePolicy || dashboardCachePolicyFromEnv();
  const installKind = detectInstallKind({ entrypoint, projectDir, installKind: options.installKind });
  const providerChecks = providerCliChecks(options);
  const foundProviderChecks = providerChecks.filter((check) => check.ok);
  const providerCliOk = foundProviderChecks.length > 0;
  const checks = [
    {
      id: "node",
      label: "Node runtime",
      ok: nodeOk,
      required: true,
      detail: nodeOk
        ? `${nodeVersion} satisfies >=${MIN_NODE_MAJOR}`
        : `${nodeVersion} is below >=${MIN_NODE_MAJOR}`,
    },
    {
      id: "default-tui",
      label: "Default TUI",
      ok: Boolean(bun),
      detail: bun
        ? `${command} opens the OpenTUI terminal workspace by default`
        : `Bun not found; install Bun or run ${command} tui --renderer node for the fallback ANSI TUI`,
    },
    {
      id: "opentui",
      label: "OpenTUI runtime",
      ok: Boolean(bun),
      detail: bun
        ? `Bun found at ${bun}`
        : "Bun not found; OpenTUI is unavailable",
    },
    {
      id: "completion",
      label: "Shell completion",
      ok: true,
      required: true,
      detail: `${command} completion <bash|zsh|fish> is available`,
    },
    {
      id: "dashboard-cache",
      label: "Dashboard cache",
      ok: true,
      detail: `${formatDashboardCachePolicy(cachePolicy)}; set CO_OD_TUI_DISABLE_DASHBOARD_CACHE or CO_OD_TUI_DASHBOARD_CACHE_MAX_AGE to change offline fallback`,
    },
    {
      id: "install-surface",
      label: "Install surface",
      ok: true,
      detail: installKindDetail(installKind),
    },
    {
      id: "provider-cli",
      label: "Provider CLI",
      ok: providerCliOk,
      required: true,
      detail: providerCliOk
        ? `ready via ${foundProviderChecks.map((check) => check.label.replace(/^Provider\s+/, "")).join(", ")}`
        : "no local provider CLI found; install Claude Code, Codex CLI, Hermes Agent, OpenCode, or ZeroClaw/OpenClaw",
    },
    ...providerChecks,
    {
      id: "live-session",
      label: "Live QA login",
      ok: sessionOk,
      required: true,
      detail: sessionDetail,
    },
    {
      id: "room-config",
      label: "Room context",
      ok: Boolean(roomContext.roomId),
      required: true,
      detail: roomConfigDetail,
    },
  ];

  return {
    version,
    command,
    node: nodeVersion,
    entrypoint,
    projectDir,
    server,
    installKind,
    checks,
    strictReady: strictDoctorFailures({ checks }).length === 0,
    installHint: installHintFor(installKind),
    updateHint: updateHintFor(installKind),
    completionHint: `${command} completion zsh|bash|fish`,
    fullTuiHint: "Full TUI: Bun is required for the public beta experience. Install Bun from https://bun.sh, then run `co-od`.",
    freePathHint: "Free path: bring your own Codex CLI, Claude Code, Hermes Agent, OpenCode, or OpenClaw credentials; co-od coordinates them in a room.",
    hostedRuntimeHint: "Hosted runtime: optional and limited; not required for local bridge or remote/local CLI agents.",
    liveQaHint: "Run `co-od login`, enter a configured project or a project with persisted TUI room state, or pass --room, then run `pnpm qa:tui:live`.",
    cachePolicy,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const strictFailures = strictDoctorFailures(report);
  const lines = [
    `co-od doctor v${report.version}`,
    "=".repeat(40),
    `Command:    ${report.command}`,
    `Node:       ${report.node}`,
    `Entrypoint: ${report.entrypoint}`,
    `Project:    ${report.projectDir}`,
    `Server:     ${report.server}`,
    "",
    "Checks:",
    ...report.checks.map((check) => {
      const mark = check.ok ? "OK " : "ERR";
      return `  ${mark} ${check.label.padEnd(16)} ${check.detail}`;
    }),
    "",
    `Install: ${report.installHint}`,
    `Update:  ${report.updateHint}`,
    `Completion: ${report.completionHint}`,
    `Full TUI: ${report.fullTuiHint.replace(/^Full TUI:\s*/, "")}`,
    `Free path: ${report.freePathHint.replace(/^Free path:\s*/, "")}`,
    `Hosted runtime: ${report.hostedRuntimeHint.replace(/^Hosted runtime:\s*/, "")}`,
    `Live QA: ${report.liveQaHint}`,
    `Strict: ${strictFailures.length === 0 ? "ready" : `blocked by ${strictFailures.map((check) => check.label).join(", ")}`}`,
  ];
  return lines.join("\n");
}

export async function run(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const strict = args.includes("--strict");
  const report = buildDoctorReport({
    projectDir: readFlagValue(args, "--dir"),
    roomId: readFlagValue(args, "--room"),
    server: readFlagValue(args, "--server"),
  });

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    if (strict && !report.strictReady) {
      process.exitCode = 1;
    }
    return;
  }

  console.log(formatDoctorReport(report));
  if (strict && !report.strictReady) {
    process.exitCode = 1;
  }
}
