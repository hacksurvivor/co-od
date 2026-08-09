import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type ProviderAuthStatus = "connected" | "not_connected" | "cli_missing";

export interface ProviderAuthRecord {
  provider: string;
  source: "external_cli" | "environment" | "co-od";
  command?: string;
  authenticatedAt: string;
  lastCheckedAt?: string;
}

export interface ProviderAuthState {
  version: 1;
  updatedAt: string;
  providers: Record<string, ProviderAuthRecord>;
  setup?: {
    skippedAt?: string;
  };
}

export interface ProviderAuthCheck {
  provider: string;
  label: string;
  command: string;
  installed: boolean;
  status: ProviderAuthStatus;
  source?: string;
  detail: string;
}

export const PROVIDER_AUTH_FILE = join(homedir(), ".co-ode", "auth.json");

const PROVIDERS = [
  {
    provider: "codex",
    label: "OpenAI Codex",
    command: "codex",
    loginArgs: ["login"],
    env: ["OPENAI_API_KEY"],
    files: [join(homedir(), ".codex", "auth.json")],
    validFile: (value: unknown) => hasAnyKey(value, ["tokens", "access_token", "refresh_token", "id_token", "OPENAI_API_KEY", "accounts"]),
  },
  {
    provider: "claude",
    label: "Claude Code",
    command: "claude",
    loginArgs: ["login"],
    env: ["ANTHROPIC_API_KEY", "ANTHROPIC_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
    files: [join(homedir(), ".claude.json"), join(homedir(), ".claude", ".credentials.json")],
    validFile: (value: unknown) => typeof value === "object" && value !== null,
  },
  {
    provider: "gemini",
    label: "Google Gemini CLI",
    command: "gemini",
    loginArgs: ["auth", "login"],
    env: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS"],
    files: [join(homedir(), ".gemini", "tokens.json")],
    validFile: (value: unknown) => hasAnyKey(value, ["access_token", "refresh_token", "token", "credentials"]),
  },
] as const;

export type ProviderAuthProvider = typeof PROVIDERS[number]["provider"];

function hasAnyKey(value: unknown, keys: string[]): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return keys.some((key) => {
    const candidate = record[key];
    if (typeof candidate === "string") return candidate.trim().length > 0;
    if (Array.isArray(candidate)) return candidate.length > 0;
    return Boolean(candidate && typeof candidate === "object");
  });
}

function which(command: string): boolean {
  return (process.env.PATH || "")
    .split(":")
    .some((dir) => existsSync(join(dir, command)));
}

function emptyState(): ProviderAuthState {
  return {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    providers: {},
  };
}

export function readProviderAuthState(): ProviderAuthState {
  try {
    const parsed = JSON.parse(readFileSync(PROVIDER_AUTH_FILE, "utf-8")) as Partial<ProviderAuthState>;
    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
      providers: parsed.providers && typeof parsed.providers === "object" ? parsed.providers as Record<string, ProviderAuthRecord> : {},
      setup: parsed.setup && typeof parsed.setup === "object" ? parsed.setup : undefined,
    };
  } catch {
    return emptyState();
  }
}

export function writeProviderAuthState(state: ProviderAuthState): void {
  const file = PROVIDER_AUTH_FILE;
  mkdirSync(dirname(file), { recursive: true });
  const next = { ...state, version: 1 as const, updatedAt: new Date().toISOString() };
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
    chmodSync(file, 0o600);
  } finally {
    try {
      rmSync(tmp);
    } catch {
      // Already renamed.
    }
  }
}

function readJsonFile(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function providerDefinition(provider: string) {
  return PROVIDERS.find((candidate) => candidate.provider === provider);
}

export function providerAuthProviders(): Array<{ provider: ProviderAuthProvider; label: string; command: string }> {
  return PROVIDERS.map(({ provider, label, command }) => ({ provider, label, command }));
}

export function checkProviderAuth(provider: string): ProviderAuthCheck {
  const definition = providerDefinition(provider);
  if (!definition) {
    return {
      provider,
      label: provider,
      command: provider,
      installed: false,
      status: "cli_missing",
      detail: `Unknown provider auth target: ${provider}`,
    };
  }

  const installed = which(definition.command);
  const envVar = definition.env.find((name) => Boolean(process.env[name]?.trim()));
  if (envVar) {
    return {
      provider: definition.provider,
      label: definition.label,
      command: definition.command,
      installed,
      status: "connected",
      source: envVar,
      detail: `${definition.label} credentials found in ${envVar}`,
    };
  }

  for (const file of definition.files) {
    if (!existsSync(file)) continue;
    const value = readJsonFile(file);
    if (definition.validFile(value)) {
      return {
        provider: definition.provider,
        label: definition.label,
        command: definition.command,
        installed,
        status: "connected",
        source: file,
        detail: `${definition.label} credentials found`,
      };
    }
  }

  const ledger = readProviderAuthState().providers[definition.provider];
  if (ledger) {
    return {
      provider: definition.provider,
      label: definition.label,
      command: definition.command,
      installed,
      status: installed ? "not_connected" : "cli_missing",
      source: ledger.source,
      detail: `${definition.label} was connected before, but provider credentials were not found.`,
    };
  }

  return {
    provider: definition.provider,
    label: definition.label,
    command: definition.command,
    installed,
    status: installed ? "not_connected" : "cli_missing",
    detail: installed
      ? `${definition.label} CLI is installed but not logged in.`
      : `${definition.label} CLI is not installed.`,
  };
}

export function checkAllProviderAuth(): ProviderAuthCheck[] {
  return PROVIDERS.map((provider) => checkProviderAuth(provider.provider));
}

export function hasAnyConnectedProvider(): boolean {
  return checkAllProviderAuth().some((check) => check.status === "connected");
}

export function providerAuthSetupWasSkipped(): boolean {
  return Boolean(readProviderAuthState().setup?.skippedAt);
}

export async function loginProvider(provider: string): Promise<ProviderAuthCheck> {
  const definition = providerDefinition(provider);
  if (!definition) {
    throw new Error(`Unknown provider auth target: ${provider}`);
  }
  if (!which(definition.command)) {
    throw new Error(`${definition.label} CLI is not installed (${definition.command}).`);
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(definition.command, definition.loginArgs, {
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${definition.command} ${definition.loginArgs.join(" ")} exited with ${code ?? 1}`));
    });
  });

  const checked = checkProviderAuth(provider);
  const state = readProviderAuthState();
  state.providers[definition.provider] = {
    provider: definition.provider,
    source: "external_cli",
    command: `${definition.command} ${definition.loginArgs.join(" ")}`,
    authenticatedAt: new Date().toISOString(),
    lastCheckedAt: new Date().toISOString(),
  };
  writeProviderAuthState(state);
  return checked.status === "connected" ? checked : checkProviderAuth(provider);
}

export function logoutProvider(provider: string): void {
  const state = readProviderAuthState();
  if (provider === "all") {
    state.providers = {};
  } else {
    delete state.providers[provider];
  }
  writeProviderAuthState(state);
}

export function markProviderAuthSetupSkipped(): void {
  const state = readProviderAuthState();
  state.setup = { ...(state.setup || {}), skippedAt: new Date().toISOString() };
  writeProviderAuthState(state);
}
