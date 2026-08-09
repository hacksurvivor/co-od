import type { AgentAdapter, HarnessCapabilities } from "./base.js";
import { AntigravityAdapter } from "./antigravity.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { CustomAdapter } from "./custom.js";
import { GeminiAdapter } from "./gemini.js";
import { GrokAdapter } from "./grok.js";
import { HermesAdapter } from "./hermes.js";
import { OpenClawAdapter } from "./openclaw.js";
import { OpenCodeAdapter } from "./opencode.js";

const adapters: Record<string, () => AgentAdapter> = {
  antigravity: () => new AntigravityAdapter(),
  agy: () => new AntigravityAdapter(),
  claude: () => new ClaudeAdapter(),
  codex: () => new CodexAdapter(),
  custom: () => new CustomAdapter(),
  gemini: () => new GeminiAdapter(),
  grok: () => new GrokAdapter(),
  hermes: () => new HermesAdapter(),
  xai: () => new GrokAdapter(),
  opencode: () => new OpenCodeAdapter(),
  openclaw: () => new OpenClawAdapter(),
  zeroclaw: () => new OpenClawAdapter(),
};

export function getAdapter(provider: string): AgentAdapter {
  const factory = adapters[provider.toLowerCase()];
  if (factory) return factory();
  throw new Error(`Unsupported provider: ${provider}`);
}

export function getHarnessCapabilities(provider: string): HarnessCapabilities {
  return getAdapter(provider).capabilities;
}

export const PROVIDER_LIST = "antigravity|claude|codex|custom|gemini|grok|hermes|opencode|openclaw|zeroclaw";
